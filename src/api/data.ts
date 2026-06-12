// API Data Handlers — Traen datos de Supabase para los endpoints

import { createSupabaseRepo } from '../db/supabaseRepo.js';
import type { Repo } from '../agent/types.js';

export async function getDashboardStats(userJwt: string, salonId: string) {
  try {
    const repo = createSupabaseRepo({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      userJwt,
      salonId,
    });

    // Obtener balance mes actual
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    const monthBalance = await repo.getBalance({
      from: monthStart.toISOString().split('T')[0],
      to: monthEnd.toISOString().split('T')[0],
    });

    // Obtener balance semana
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const weekBalance = await repo.getBalance({
      from: weekStart.toISOString().split('T')[0],
      to: weekEnd.toISOString().split('T')[0],
    });

    // Hoy
    const todayStr = today.toISOString().split('T')[0];
    const todayBalance = await repo.getBalance({
      from: todayStr,
      to: todayStr,
    });

    return {
      today: todayBalance.income || 0,
      week: weekBalance.income || 0,
      month: monthBalance.income || 0,
      monthExpenses: monthBalance.expense || 0,
      netBalance: (monthBalance.income || 0) - (monthBalance.expense || 0),
      weekExpenses: weekBalance.expense || 0,
    };
  } catch (error) {
    console.error('getDashboardStats error:', error);
    throw error;
  }
}

export async function getClientsList(userJwt: string, salonId: string) {
  try {
    const repo = createSupabaseRepo({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      userJwt,
      salonId,
    });

    // Traer todos los clientes
    const clients = await repo.findClients('');

    return {
      clients: clients.slice(0, 10),
      total: clients.length,
    };
  } catch (error) {
    console.error('getClientsList error:', error);
    throw error;
  }
}

export async function getTransactionsList(userJwt: string, salonId: string) {
  try {
    const repo = createSupabaseRepo({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      userJwt,
      salonId,
    });

    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    const monthBalance = await repo.getBalance({
      from: monthStart.toISOString().split('T')[0],
      to: monthEnd.toISOString().split('T')[0],
    });

    return {
      transactions: [],
      total: 0,
      income: monthBalance.income || 0,
      expenses: monthBalance.expense || 0,
      balance: monthBalance.balance || 0,
    };
  } catch (error) {
    console.error('getTransactionsList error:', error);
    throw error;
  }
}

export async function getReportsSummary(userJwt: string, salonId: string) {
  try {
    const repo = createSupabaseRepo({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
      userJwt,
      salonId,
    });

    const today = new Date();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const weekBalance = await repo.getBalance({
      from: weekStart.toISOString().split('T')[0],
      to: weekEnd.toISOString().split('T')[0],
    });

    const auditLog = await repo.getAuditLog();

    return {
      weekIncome: weekBalance.income || 0,
      weekExpenses: weekBalance.expense || 0,
      netWeek: weekBalance.balance || 0,
      transactionCount: auditLog.length,
      period: {
        start: weekStart.toISOString().split('T')[0],
        end: weekEnd.toISOString().split('T')[0],
      },
    };
  } catch (error) {
    console.error('getReportsSummary error:', error);
    throw error;
  }
}
