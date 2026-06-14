import { Hono } from 'hono'
import { getSupabaseAdmin } from '../integrations/supabase.js'

export const demonioRoutes = new Hono()

/**
 * POST /api/demonio/execute
 * Ejecuta workflow N8N desde DIABOLUS
 */
demonioRoutes.post('/execute', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))

    const { action, data, auto_approve = false } = body as {
      action: string
      data: any
      auto_approve?: boolean
    }

    // 1. VALIDAR USUARIO
    const userId = c.get('userId') as string | undefined
    const salonId = c.get('salonId') as string | undefined

    if (!userId || !salonId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    // 2. VALIDAR ACCIÓN
    const validActions = [
      'import_clients',
      'reconcile_bank',
      'generate_report',
      'sync_accounting'
    ]

    if (!validActions.includes(action)) {
      return c.json({
        error: `Invalid action. Valid: ${validActions.join(', ')}`
      }, 400)
    }

    // 3. VALIDAR LÍMITES DE USO
    const usage = await checkDemonioUsage(salonId)
    if (usage.executions >= usage.limit) {
      return c.json(
        {
          error: 'Demonio limit exceeded',
          used: usage.executions,
          limit: usage.limit,
          message: `Has alcanzado el límite de ${usage.limit} ejecuciones este mes`
        },
        429
      )
    }

    // 4. GUARDAR TAREA EN BD
    const taskId = crypto.randomUUID()
    const supabase = getSupabaseAdmin()

    await supabase.from('demonio_tasks').insert([
      {
        id: taskId,
        salon_id: salonId,
        user_id: userId,
        action: action,
        status: 'pending',
        data: data,
        auto_approve: auto_approve,
        created_at: new Date().toISOString()
      }
    ])

    // 5. LLAMAR N8N WEBHOOK
    const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL

    if (!n8nWebhookUrl) {
      console.warn('[Demonio] N8N_WEBHOOK_URL not configured')
      // Para dev, retornar mock
      return c.json({
        status: 'success_mock',
        task_id: taskId,
        message: 'Workflow initiated (mock mode)',
        polling_url: `/api/demonio/status/${taskId}`
      })
    }

    try {
      const response = await fetch(n8nWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.DIABOLUS_SERVICE_TOKEN_N8N || ''}`
        },
        body: JSON.stringify({
          task_id: taskId,
          salon_id: salonId,
          user_id: userId,
          action: action,
          data: data,
          auto_approve: auto_approve,
          callback_url: `${process.env.DIABOLUS_API_URL || 'http://localhost:3000'}/api/demonio/callback`
        })
      })

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        console.error('N8N error:', error)

        // Marcar como fallida
        await supabase
          .from('demonio_tasks')
          .update({
            status: 'failed',
            error: error.message || 'N8N workflow failed'
          })
          .eq('id', taskId)

        return c.json(
          {
            error: 'N8N workflow failed',
            details: error.message
          },
          500
        )
      }
    } catch (fetchErr) {
      console.error('[N8N Fetch] Error:', fetchErr)
      // No fallar si N8N no está disponible, solo retornar pending
    }

    // 6. RETORNAR TASK ID
    return c.json({
      status: 'success',
      task_id: taskId,
      message: 'Workflow initiated',
      polling_url: `/api/demonio/status/${taskId}`
    })
  } catch (err) {
    console.error('[Demonio Execute] Error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

/**
 * GET /api/demonio/status/:taskId
 * Obtener estado de tarea en tiempo real
 */
demonioRoutes.get('/status/:taskId', async (c) => {
  try {
    const { taskId } = c.req.param()

    const userId = c.get('userId') as string | undefined
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('demonio_tasks')
      .select('*')
      .eq('id', taskId)
      .single()

    if (error) {
      return c.json({ error: 'Task not found' }, 404)
    }

    // Verificar que el usuario sea propietario
    if (data.user_id !== userId) {
      return c.json({ error: 'Unauthorized' }, 403)
    }

    return c.json({
      task_id: taskId,
      status: data.status,
      action: data.action,
      result: data.result || null,
      error: data.error || null,
      preview: data.preview || null,
      created_at: data.created_at,
      updated_at: data.updated_at
    })
  } catch (err) {
    console.error('[Demonio Status] Error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

/**
 * POST /api/demonio/callback
 * N8N llama aquí cuando termina el workflow
 * (sin auth, N8N lo llama directamente)
 */
demonioRoutes.post('/callback', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}))

    const { task_id, status, result, error, preview } = body as {
      task_id: string
      status: 'completed' | 'failed' | 'requires_approval'
      result?: any
      error?: string
      preview?: any
    }

    if (!task_id || !status) {
      return c.json({ error: 'Missing task_id or status' }, 400)
    }

    const supabase = getSupabaseAdmin()

    // Actualizar tarea
    const { error: updateErr } = await supabase
      .from('demonio_tasks')
      .update({
        status: status,
        result: result,
        error: error,
        preview: preview,
        updated_at: new Date().toISOString()
      })
      .eq('id', task_id)

    if (updateErr) {
      console.error('Update error:', updateErr)
      return c.json({ error: 'Failed to update task' }, 500)
    }

    // Si completada, registrar en auditoría
    if (status === 'completed') {
      const { data: task } = await supabase
        .from('demonio_tasks')
        .select('*')
        .eq('id', task_id)
        .single()

      if (task) {
        await supabase.from('audit_log').insert([
          {
            user_id: task.user_id,
            salon_id: task.salon_id,
            action: `demonio_${task.action}`,
            changes: result,
            created_at: new Date().toISOString()
          }
        ])

        console.log(`✅ Task ${task_id} completed: ${task.action}`)
      }
    }

    return c.json({ received: true })
  } catch (err) {
    console.error('[Demonio Callback] Error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

/**
 * POST /api/demonio/approve/:taskId
 * Usuario aprueba cambios
 */
demonioRoutes.post('/approve/:taskId', async (c) => {
  try {
    const { taskId } = c.req.param()

    const userId = c.get('userId') as string | undefined
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const supabase = getSupabaseAdmin()

    // Obtener tarea
    const { data: task, error: fetchErr } = await supabase
      .from('demonio_tasks')
      .select('*')
      .eq('id', taskId)
      .single()

    if (fetchErr || !task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    // Verificar propietario
    if (task.user_id !== userId) {
      return c.json({ error: 'Unauthorized' }, 403)
    }

    // Verificar estado
    if (task.status !== 'requires_approval') {
      return c.json(
        {
          error: 'Task not pending approval',
          current_status: task.status
        },
        400
      )
    }

    // Marcar como ejecutando
    await supabase
      .from('demonio_tasks')
      .update({ status: 'executing' })
      .eq('id', taskId)

    // Notificar a N8N si está configurado
    const approvalWebhook = process.env.N8N_APPROVAL_WEBHOOK
    if (approvalWebhook) {
      try {
        await fetch(approvalWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_id: taskId,
            action: 'approve'
          })
        })
      } catch (err) {
        console.warn('[N8N Approval] Webhook failed:', err)
      }
    }

    return c.json({
      status: 'approved',
      task_id: taskId,
      message: 'Workflow approved and executing'
    })
  } catch (err) {
    console.error('[Demonio Approve] Error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

/**
 * POST /api/demonio/reject/:taskId
 * Usuario rechaza cambios
 */
demonioRoutes.post('/reject/:taskId', async (c) => {
  try {
    const { taskId } = c.req.param()

    const userId = c.get('userId') as string | undefined
    if (!userId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const supabase = getSupabaseAdmin()

    const { data: task, error: fetchErr } = await supabase
      .from('demonio_tasks')
      .select('*')
      .eq('id', taskId)
      .single()

    if (fetchErr || !task) {
      return c.json({ error: 'Task not found' }, 404)
    }

    if (task.user_id !== userId) {
      return c.json({ error: 'Unauthorized' }, 403)
    }

    // Marcar como rechazada
    await supabase
      .from('demonio_tasks')
      .update({
        status: 'rejected',
        error: 'User rejected changes'
      })
      .eq('id', taskId)

    return c.json({
      status: 'rejected',
      task_id: taskId
    })
  } catch (err) {
    console.error('[Demonio Reject] Error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

/**
 * GET /api/demonio/history
 * Historial de ejecuciones del usuario
 */
demonioRoutes.get('/history', async (c) => {
  try {
    const userId = c.get('userId') as string | undefined
    const salonId = c.get('salonId') as string | undefined

    if (!userId || !salonId) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('demonio_tasks')
      .select('*')
      .eq('salon_id', salonId)
      .order('created_at', { ascending: false })
      .limit(20)

    if (error) {
      return c.json({ error: 'Failed to fetch history' }, 500)
    }

    return c.json({
      tasks: data.map((task) => ({
        id: task.id,
        action: task.action,
        status: task.status,
        created_at: task.created_at,
        updated_at: task.updated_at
      }))
    })
  } catch (err) {
    console.error('[Demonio History] Error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

/**
 * Valida límites de uso por plan
 */
async function checkDemonioUsage(salonId: string) {
  const supabase = getSupabaseAdmin()

  try {
    // Obtener plan del salón
    const { data: salon } = await supabase
      .from('salons')
      .select('subscription_plan')
      .eq('id', salonId)
      .single()

    // Contar ejecuciones este mes
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const { count } = await supabase
      .from('demonio_tasks')
      .select('*', { count: 'exact' })
      .eq('salon_id', salonId)
      .gte('created_at', startOfMonth.toISOString())

    // Límites por plan
    const limits: Record<string, number> = {
      amigos: 10,
      profesional: 100,
      enterprise: 1000
    }

    const limit = limits[salon?.subscription_plan || 'amigos'] || 10

    return {
      executions: count || 0,
      limit: limit
    }
  } catch (err) {
    console.error('[checkDemonioUsage] Error:', err)
    // Default: sin límite en dev
    return { executions: 0, limit: 1000 }
  }
}
