import { RuntimeContext } from "../services/RuntimeContextResolver";

export enum LifecycleState {
  BOOTSTRAPPING = "BOOTSTRAPPING",
  HYDRATING = "HYDRATING",
  READY = "READY",
  PROCESSING = "PROCESSING",
  WAITING_TOOL = "WAITING_TOOL",
  WAITING_AGENT = "WAITING_AGENT",
  RESPONDING = "RESPONDING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  DESTROYED = "DESTROYED"
}

export interface RuntimeMetadata {
  clientIp?: string;
  userAgent?: string;
  locale: string;
  timezone: string;
}

export interface RuntimeFlags {
  allowReply: boolean;
  allowWorkflow: boolean;
  allowToolExecution: boolean;
  allowTicketCreation: boolean;
  allowTakeover: boolean;
  allowMemoryWrite: boolean;
}

export interface ConversationState {
  id: number;
  status: "open" | "pending" | "escalated" | "resolved" | "closed";
  handledBy: "ai" | "human";
  channel: string;
  lastMessageAt?: Date;
}

export interface TicketState {
  id?: number;
  ticketCode?: string;
  status?: "Open" | "In Progress" | "Resolved" | "Closed" | "Duplicate" | "Cancelled";
  priority?: "Urgent" | "High" | "Medium" | "Low" | "None";
  slaBreached: boolean;
}

export class SimpleRuntimeCache {
  private cache = new Map<string, any>();

  get<T>(key: string): T | null {
    return this.cache.get(key) ?? null;
  }

  set<T>(key: string, value: T): void {
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

const ALLOWED_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  [LifecycleState.BOOTSTRAPPING]: [LifecycleState.HYDRATING, LifecycleState.FAILED],
  [LifecycleState.HYDRATING]: [LifecycleState.READY, LifecycleState.FAILED],
  [LifecycleState.READY]: [LifecycleState.PROCESSING, LifecycleState.FAILED],
  [LifecycleState.PROCESSING]: [LifecycleState.WAITING_TOOL, LifecycleState.WAITING_AGENT, LifecycleState.RESPONDING, LifecycleState.FAILED],
  [LifecycleState.WAITING_TOOL]: [LifecycleState.PROCESSING, LifecycleState.FAILED],
  [LifecycleState.WAITING_AGENT]: [LifecycleState.PROCESSING, LifecycleState.FAILED],
  [LifecycleState.RESPONDING]: [LifecycleState.COMPLETED, LifecycleState.FAILED],
  [LifecycleState.COMPLETED]: [LifecycleState.DESTROYED],
  [LifecycleState.FAILED]: [LifecycleState.DESTROYED],
  [LifecycleState.DESTROYED]: []
};

export class IssueSession {
  public state: LifecycleState = LifecycleState.BOOTSTRAPPING;
  public readonly cache = new SimpleRuntimeCache();

  constructor(
    public readonly sessionId: string,
    public readonly context: RuntimeContext,
    public readonly flags: RuntimeFlags,
    public readonly metadata: RuntimeMetadata,
    public conversation: ConversationState,
    public ticket: TicketState
  ) {}

  canExecuteTool(toolName: string): boolean {
    return this.flags.allowToolExecution && this.state === LifecycleState.PROCESSING;
  }

  transitionTo(newState: LifecycleState): void {
    const allowed = ALLOWED_TRANSITIONS[this.state] || [];
    if (!allowed.includes(newState)) {
      throw new Error(`Invalid lifecycle state transition from ${this.state} to ${newState}`);
    }
    this.state = newState;
  }

  takeSnapshot(): string {
    return JSON.stringify({
      state: this.state,
      conversation: this.conversation,
      ticket: this.ticket
    });
  }

  restoreSnapshot(memento: string): void {
    try {
      const parsed = JSON.parse(memento);
      if (parsed.state) this.state = parsed.state;
      if (parsed.conversation) this.conversation = parsed.conversation;
      if (parsed.ticket) this.ticket = parsed.ticket;
    } catch (err: any) {
      throw new Error(`Failed to restore IssueSession snapshot: ${err.message}`);
    }
  }
}
