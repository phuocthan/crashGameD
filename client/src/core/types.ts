// Engine-agnostic types shared by the network layer and any renderer (PixiJS now, Cocos later).

export type Phase = 'connecting' | 'paused' | 'betting' | 'running' | 'crashed';

export interface RoundInfo {
  phase: Phase;
  roundId?: number;
  bettingEndsAt?: number;
  startedAt?: number | null;
  crashPoint?: number;
  hash?: string;
  crashedAtMs?: number;
}

export interface PublicBet {
  username: string;
  slot: number;
  amount: number;          // cents
  autoCashout: number | null;
  cashoutAt: number | null;
  payout: number;          // cents
}

export interface GameConfig {
  minBet: number;
  maxBet: number;
  maxAutoCashout: number;
  houseEdge: number;
  bettingMs: number;
}

export interface User {
  id: number;
  username: string;
  balance: number;
}

export interface Ack {
  reqId: number;
  ok: boolean;
  code?: string;
  error?: string;
  [k: string]: unknown;
}
