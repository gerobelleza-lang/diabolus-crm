// SupabaseRepo — Implementación con RLS multi-tenant
// Mismo interfaz que InMemoryRepo, cero cambios en agente

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuditEntry, Client, Invoice, Reminder, Repo, Service, Transaction,
} from '../agent/types.js';

interface SupabaseRepoOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
  userJwt: string;
  salonId: string;
}

export function createSupabaseRepo(opts: SupabaseRepoOptions): Repo {
  const supabase: SupabaseClient = createClient(opts.supabaseUrl, opts.supabaseAnonKey, {
    auth: { persistSession: false },
    global: {
      headers: {
        authorization: `Bearer ${opts.userJwt}`,
      },
    },
  });

  const salonId = opts.salonId;

  return {
    async createClient(data) {
      const { data: client, error } = await supabase
        .from('clients')
        .insert([{ salon_id: salonId, ...data }])
        .select()
        .single();
      if (error) throw new Error(`createClient: ${error.message}`);
      return client as Client;
    },

    async findClients(query) {
      const { data, error } = await supabase
        .from('clients')
        .select()
        .eq('salon_id', salonId)
        .ilike('name', `%${query}%`);
      if (error) throw new Error(`findClients: ${error.message}`);
      return (data || []) as Client[];
    },

    async findServices(query) {
      const { data, error } = await supabase
        .from('services')
        .select()
        .eq('salon_id', salonId)
        .ilike('name', `%${query}%`);
      if (error) throw new Error(`findServices: ${error.message}`);
      return (data || []) as Service[];
    },

    async seedService(name, defaultPrice) {
      const { data: service, error } = await supabase
        .from('services')
        .insert([{ salon_id: salonId, name, default_price: defaultPrice }])
        .select()
        .single();
      if (error) throw new Error(`seedService: ${error.message}`);
      return service as Service;
    },

    async createTransaction(data) {
      const { data: tx, error } = await supabase
        .from('transactions')
        .insert([{
          salon_id: salonId,
          type: data.type,
          amount: data.amount,
          concept: data.concept,
          client_id: data.clientId,
          date: data.date,
          
        }])
        .select()
        .single();
      if (error) throw new Error(`createTransaction: ${error.message}`);
      return tx as Transaction;
    },

    async getBalance(period) {
      let query = supabase
        .from('transactions')
        .select()
        .eq('salon_id', salonId);

      if (period) {
        query = query.gte('date', period.from).lte('date', period.to);
      }

      const { data, error } = await query;
      if (error) throw new Error(`getBalance: ${error.message}`);

      const transactions = (data || []) as Transaction[];
      const income = transactions
        .filter((t) => t.type === 'income')
        .reduce((sum, t) => sum + t.amount, 0);
      const expense = transactions
        .filter((t) => t.type === 'expense')
        .reduce((sum, t) => sum + t.amount, 0);

      return {
        income: Math.round(income * 100) / 100,
        expense: Math.round(expense * 100) / 100,
        balance: Math.round((income - expense) * 100) / 100,
      };
    },

    async createInvoice(data) {
      const { data: invoice, error } = await supabase
        .from('invoices')
        .insert([{ salon_id: salonId, ...data }])
        .select()
        .single();
      if (error) throw new Error(`createInvoice: ${error.message}`);
      return invoice as Invoice;
    },

    async getPendingInvoices() {
      const { data, error } = await supabase
        .from('invoices')
        .select()
        .eq('salon_id', salonId)
        .neq('status', 'paid')
        .order('due_date', { ascending: true });
      if (error) throw new Error(`getPendingInvoices: ${error.message}`);
      return (data || []) as Invoice[];
    },

    async createReminder(data) {
      const { data: reminder, error } = await supabase
        .from('reminders')
        .insert([{ salon_id: salonId, ...data }])
        .select()
        .single();
      if (error) throw new Error(`createReminder: ${error.message}`);
      return reminder as Reminder;
    },

    async audit(entry) {
      const { data, error } = await supabase
        .from('audit_log')
        .insert([{
          salon_id: salonId,
          tool_name: entry.toolName,
          payload: entry.payload,
          result: entry.result,
          confirmed: entry.confirmed,
        }])
        .select()
        .single();
      if (error) throw new Error(`audit: ${error.message}`);
      return data as AuditEntry;
    },

    async getAuditLog() {
      const { data, error } = await supabase
        .from('audit_log')
        .select()
        .eq('salon_id', salonId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(`getAuditLog: ${error.message}`);
      return (data || []) as AuditEntry[];
    },
  };
}

export type { SupabaseRepoOptions };
