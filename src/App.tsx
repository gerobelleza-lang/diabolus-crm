import React, { useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { ChatWidget } from './components/ChatWidget';
import { Card, CardHeader, CardTitle, CardContent } from './components/ui/Card';
import { Zap } from 'lucide-react';

export function App() {
  // Demo: usando credenciales de prueba
  const demoJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVteWdidnhraGZid3loYmFwYWFlIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJzdWIiOiI0M2M4ZTFmMi0wNzI0LTRjZmYtODk3Yi03NzM3NmMwOTQwMTciLCJlbWFpbCI6ImFkbWluQGRpYWJvbHVzLmxvY2FsIiwic2Fsb25faWQiOiJlM2NkY2JmOS1kZTgyLTQ0ZDgtODFlNC1lNDM0OGRjZTY3MTQiLCJpYXQiOjE3ODEyOTY5MjcsImV4cCI6MTgxMjgzMjkyN30.mX5OhrdExpBDm9ZueacJ0HP53HrW4KIbyTT9yps2HYQ';
  const demoSalonId = 'e3cdcbf9-de82-44d8-81e4-e4348dce6714';

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      {/* Header */}
      <header className="bg-black border-b border-gray-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Zap className="w-8 h-8 text-orange-500" />
            <h1 className="text-2xl font-bold text-white">Diabolus v40</h1>
          </div>
          <p className="text-gray-400 text-sm">Production Grade CRM</p>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Dashboard Stats */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-4">Estado del Sistema</h2>
          <Dashboard jwtToken={demoJwt} salonId={demoSalonId} />
        </section>

        {/* Chat Section */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>💬 Agente Inteligente</CardTitle>
              </CardHeader>
              <CardContent>
                <ChatWidget jwtToken={demoJwt} salonId={demoSalonId} />
              </CardContent>
            </Card>
          </div>

          {/* Info Panel */}
          <aside className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Capacidades</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-gray-300">
                <div>
                  <p className="font-semibold text-white">Parser L0</p>
                  <p>Patrones determinísticos (costo cero)</p>
                </div>
                <div>
                  <p className="font-semibold text-white">LLM L1-L3</p>
                  <p>OpenRouter para comandos complejos</p>
                </div>
                <div>
                  <p className="font-semibold text-white">Multi-tenant</p>
                  <p>Aislamiento por JWT + RLS</p>
                </div>
                <div>
                  <p className="font-semibold text-white">Auditoría</p>
                  <p>Log append-only inmutable</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Stack</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-gray-300">
                <p>🚀 Vercel (deployment)</p>
                <p>🗄️ Supabase (RLS + DB)</p>
                <p>🧠 OpenRouter (LLM)</p>
                <p>⚡ Hono (backend)</p>
                <p>⚛️ React (frontend)</p>
              </CardContent>
            </Card>
          </aside>
        </section>
      </main>
    </div>
  );
}
