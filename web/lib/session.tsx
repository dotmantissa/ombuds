'use client';
import { createContext, useContext } from 'react';
export interface Session {
  ready: boolean; authenticated: boolean; memberAddress: string | null; email: string | null;
  getAccessToken: () => Promise<string | null>; login: () => void; logout: () => Promise<void>;
}
export const SessionContext = createContext<Session>({ ready: true, authenticated: false,
  memberAddress: null, email: null, getAccessToken: async () => null, login: () => undefined, logout: async () => undefined });
export function useSession() { return useContext(SessionContext); }
