// Implementación InMemoryRepo: permite ejecutar Diabolus SIN Postgres
// (desarrollo, demos y tests). La implementación PostgresRepo (Drizzle)
// es el primer trabajo de v39.1 — misma interfaz, cero cambios en el agente.

import { randomUUID } from 'node:crypto';
import type {
  AuditEntry, Client, Invoice, Reminder, Repo, Service, Transaction,
} from '../agent/types.js';
import { normalize } from '../agent/parser.js';

export function createInMemoryRepo(): Repo {
  const clients: Client[] = [];
  const services: Service[] = [];
  const transactions: Transaction[] = [];
  const invoices: Invoice[] = [];
  const reminders: Reminder[] = [];
  const auditLog: AuditEntry[] = [];
  let invoiceSeq = 0;

  const now = () => new Date().toISOString();
  const today = () => new Date().toISOString().slice(0, 10);

  return {
    async createClient(data) {
      const client: Client = { id: randomUUID(), ...data, createdAt: now() };
      clients.push(client);
      return client;
    },

    async findClients(query) {
      const q = normalize(query);
      return clients.filter((c) => normalize(c.name).includes(q));
    },

    async findServices(query) {
      const q = normalize(query);
      return services.filter((s) => normalize(s.name).includes(q));
    },

    async seedService(name, defaultPrice) {
      const service: Service = { id: randomUUID(), name, defaultPrice, createdAt: now() };
      services.push(service);
      return service;
    },

    async createTransaction(data) {
      const tx: Transaction = { id: randomUUID(), createdAt: now(), ...data, date: data.date || today() };
      transactions.push(tx);
      return tx;
    },

    async getBalance(period) {
      const inRange = (t: Transaction) =>
        !period || (t.date >= period.from && t.date <= period.to);
      const income = round2(transactions.filter((t) => t.type === 'income' && inRange(t)).reduce((s, t) => s + t.amount, 0));
      const expense = round2(transactions.filter((t) => t.type === 'expense' && inRange(t)).reduce((s, t) => s + t.amount, 0));
      return { income, expense, balance: round2(income - expense) };
    },

    async createInvoice(data) {
      invoiceSeq += 1;
      const total = round2(data.lines.reduce((s, l) => s + l.amount, 0));
      const invoice: Invoice = {
        id: randomUUID(),
        number: `${new Date().getFullYear()}-${String(invoiceSeq).padStart(4, '0')}`,
        total,
        status: 'draft',
        createdAt: now(),
        ...data,
        date: data.date || today(),
      };
      invoices.push(invoice);
      return invoice;
    },

    async getPendingInvoices() {
      return invoices.filter((i) => i.status !== 'paid');
    },

    async createReminder(data) {
      const reminder: Reminder = { id: randomUUID(), status: 'pending', createdAt: now(), ...data };
      reminders.push(reminder);
      return reminder;
    },

    async audit(entry) {
      const full: AuditEntry = { id: randomUUID(), createdAt: now(), ...entry };
      auditLog.push(full);
      return full;
    },

    async getAuditLog() {
      return [...auditLog];
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
