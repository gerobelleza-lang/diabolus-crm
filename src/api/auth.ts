// API Auth Handlers — Login, Signup, validación JWT

import { createClient } from '@supabase/supabase-js';

export async function handleLogin(email: string, password: string) {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || ''
    );

    // Autenticar con Supabase
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw new Error(error.message);
    if (!data.user) throw new Error('No user returned');

    // Obtener salon_id del usuario (de tabla salons)
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || '',
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );

    const { data: salons, error: salonsError } = await supabaseAdmin
      .from('salons')
      .select('id')
      .eq('user_id', data.user.id)
      .limit(1);

    if (salonsError || !salons || salons.length === 0) {
      throw new Error('No salon found for user');
    }

    return {
      token: data.session?.access_token || '',
      salonId: salons[0].id,
      email: data.user.email,
    };
  } catch (error) {
    console.error('handleLogin error:', error);
    throw error;
  }
}

export async function handleSignup(
  businessName: string,
  email: string,
  password: string,
  profession: string
) {
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_ANON_KEY || ''
    );

    // Crear usuario en Supabase Auth
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) throw new Error(error.message);
    if (!data.user) throw new Error('No user returned');

    // Crear salon para el usuario (será creado automáticamente por trigger)
    // El trigger handle_new_user() crea el salon automáticamente

    return {
      token: data.session?.access_token || '',
      salonId: data.user.id, // El salon_id será el primer salon creado para este usuario
      email: data.user.email,
    };
  } catch (error) {
    console.error('handleSignup error:', error);
    throw error;
  }
}

export function validateJWT(jwt: string): boolean {
  try {
    if (!jwt) return false;
    // Validación básica: JWT debe tener 3 partes separadas por puntos
    const parts = jwt.split('.');
    return parts.length === 3;
  } catch (error) {
    return false;
  }
}
