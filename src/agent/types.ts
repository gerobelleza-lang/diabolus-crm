// Tipos compartidos de Diabolus v39

export type ToolName =
  | 'create_income'
  | 'create_expense'
  | 'create_invoice'
  | 'create_client'
  | 'create_reminder'
  | 'draft_message'
  | 'send_to_gestoria'
  | 'find_client'
  | 'find_service'
  | 'get_balance'
  | 'get_pending_invoices'
  | 'get_date';

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

/** Resultado del router: por qué nivel se resuelve la consulta */
export type RouteLevel = 0 | 1 | 2 | 3;

export interface RouteDecision {
  level: RouteLevel;
  reason: string;
  /** Solo en nivel 0: la tool call ya resuelta por el parser determinista */
  toolCall?: ToolCall;
}

/** Toda escritura pasa por aquí antes de ejecutarse */
export interface PendingConfirmation {
  id: string;
  toolCall: ToolCall;
  preview: string;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  toolName: ToolName;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  confirmed: boolean;
  level: RouteLevel;
  createdAt: string;
}

// ── Entidades de dominio (espejo del esquema SQL, sección 3 del SPEC) ──

export interface Client {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  createdAt: string;
}

export interface Service {
  id: string;
  name: string;
  defaultPrice: number;
  createdAt: string;
}

export interface Transaction {
  id: string;
  type: 'income' | 'expense';
  amount: number; // céntimos NO: euros con 2 decimales, validado por Zod
  concept: string;
  clientId?: string;
  serviceId?: string;
  date: string; // ISO yyyy-mm-dd
  createdAt: string;
}

export interface Invoice {
  id: string;
  clientId: string;
  number: string;
  lines: Array<{ concept: string; amount: number; serviceId?: string }>;
  total: number;
  status: 'draft' | 'sent' | 'paid';
  date: string;
  createdAt: string;
}

export interface Reminder {
  id: string;
  dueAt: string;
  message: string;
  status: 'pending' | 'done';
  createdAt: string;
}

/**
 * Repositorio: interfaz única de acceso a datos.
 * Implementaciones: InMemoryRepo (dev/tests) y PostgresRepo (producción, v39.1).
 * El agente NUNCA toca la base de datos directamente — solo a través de tools
 * que usan este repositorio.
 */
export interface Repo {
  // clientes
  createClient(data: { name: string; phone?: string; email?: string }): Promise<Client>;
  findClients(query: string): Promise<Client[]>;
  // servicios
  findServices(query: string): Promise<Service[]>;
  seedService(name: string, defaultPrice: number): Promise<Service>;
  // transacciones
  createTransaction(data: Omit<Transaction, 'id' | 'createdAt'>): Promise<Transaction>;
  getBalance(period?: { from: string; to: string }): Promise<{ income: number; expense: number; balance: number }>;
  // facturas
  createInvoice(data: Omit<Invoice, 'id' | 'createdAt' | 'number' | 'total' | 'status'>): Promise<Invoice>;
  getPendingInvoices(): Promise<Invoice[]>;
  // recordatorios
  createReminder(data: { dueAt: string; message: string }): Promise<Reminder>;
  // auditoría
  audit(entry: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<AuditEntry>;
  getAuditLog(): Promise<AuditEntry[]>;
}
