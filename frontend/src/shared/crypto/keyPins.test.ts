import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acceptNewKey,
  checkPin,
  clearKeyPins,
  getPin,
  keyFingerprint,
  pinKey,
  safetyNumber,
  setVerified,
} from './keyPins'

vi.mock('../platform', () => ({ getPlatform: () => 'web', isNative: () => false }))

// Minimal localStorage for the pin store (vitest runs in node).
function installLocalStorage() {
  const store = new Map<string, string>()
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true })
}

const fakeKey = (fill: number) => btoa(String.fromCharCode(...new Array<number>(32).fill(fill)))
const KEY_A = fakeKey(1)
const KEY_B = fakeKey(2)
const KEY_C = fakeKey(3)

beforeEach(() => {
  installLocalStorage()
  clearKeyPins()
})

describe('pin state machine', () => {
  it('first sight is new, then match, then changed', () => {
    expect(checkPin(7, KEY_A)).toEqual({ status: 'new' })
    pinKey(7, KEY_A, 1000)
    expect(checkPin(7, KEY_A)).toMatchObject({ status: 'match', pin: { publicKey: KEY_A, verified: false } })
    expect(checkPin(7, KEY_B)).toMatchObject({ status: 'changed', pin: { publicKey: KEY_A }, newKey: KEY_B })
  })

  it('accepting a new key replaces the pin and drops verification', () => {
    pinKey(7, KEY_A, 1000)
    setVerified(7, true)
    expect(getPin(7)?.verified).toBe(true)
    acceptNewKey(7, KEY_B, 2000)
    expect(getPin(7)).toMatchObject({ publicKey: KEY_B, verified: false, pinnedAt: 2000 })
    expect(checkPin(7, KEY_A).status).toBe('changed')
  })

  it('setVerified on an unknown user is a no-op', () => {
    expect(setVerified(99, true)).toBeNull()
    expect(getPin(99)).toBeNull()
  })

  it('pins are independent per user and survive a corrupt store', () => {
    pinKey(1, KEY_A)
    pinKey(2, KEY_B)
    expect(checkPin(1, KEY_B).status).toBe('changed')
    expect(checkPin(2, KEY_B).status).toBe('match')
    localStorage.setItem('e2e_key_pins_v1', '{not json')
    expect(checkPin(1, KEY_A)).toEqual({ status: 'new' })
  })

  it('clearKeyPins wipes everything', () => {
    pinKey(1, KEY_A)
    clearKeyPins()
    expect(getPin(1)).toBeNull()
  })
})

describe('fingerprints and safety numbers', () => {
  it('fingerprint is deterministic, 8 hex groups, and differs per key', async () => {
    const fp1 = await keyFingerprint(KEY_A)
    const fp2 = await keyFingerprint(KEY_A)
    const fp3 = await keyFingerprint(KEY_B)
    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/)
    expect(fp1).not.toBe(fp3)
  })

  it('safety number is symmetric and formatted as 12 groups of 5 digits', async () => {
    const me = { userId: 10, publicKey: KEY_A }
    const peer = { userId: 3, publicKey: KEY_B }
    const mine = await safetyNumber(me, peer)
    const theirs = await safetyNumber(peer, me)
    expect(mine).toBe(theirs)
    expect(mine).toMatch(/^(\d{5} ){11}\d{5}$/)
  })

  it('safety number changes when either key or either id changes', async () => {
    const base = await safetyNumber({ userId: 1, publicKey: KEY_A }, { userId: 2, publicKey: KEY_B })
    expect(await safetyNumber({ userId: 1, publicKey: KEY_C }, { userId: 2, publicKey: KEY_B })).not.toBe(base)
    expect(await safetyNumber({ userId: 1, publicKey: KEY_A }, { userId: 2, publicKey: KEY_C })).not.toBe(base)
    expect(await safetyNumber({ userId: 5, publicKey: KEY_A }, { userId: 2, publicKey: KEY_B })).not.toBe(base)
  })
})
