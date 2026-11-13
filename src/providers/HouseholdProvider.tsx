import { useQuery } from '@tanstack/react-query'
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Household, HouseholdMember, Profile } from '../lib/types'
import { useAuth } from './AuthProvider'

export interface HouseholdState {
  household: Household | null
  members: (HouseholdMember & { profile: Profile | null })[]
  myRole: 'owner' | 'member' | null
  profileById: (id: string | null | undefined) => Profile | null
  loading: boolean
  error: unknown
  refetch: () => void
}

const Ctx = createContext<HouseholdState | null>(null)
const FALLBACK_COLORS = ['#ea580c', '#7c3aed', '#2563eb', '#db2777', '#16a34a']

/** Carga el espacio compartido del usuario (uno por usuario en esta versión). */
export function HouseholdProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()

  const q = useQuery({
    queryKey: ['household', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data: membership, error: e1 } = await supabase
        .from('household_members')
        .select('household_id')
        .eq('user_id', user!.id)
        .order('joined_at')
        .limit(1)
        .maybeSingle()
      if (e1) throw e1
      if (!membership) return { household: null, members: [], profiles: [] }

      const hid = membership.household_id as string
      const [h, m] = await Promise.all([
        supabase.from('households').select('*').eq('id', hid).single(),
        supabase.from('household_members').select('*').eq('household_id', hid).order('joined_at'),
      ])
      if (h.error) throw h.error
      if (m.error) throw m.error
      const ids = (m.data as HouseholdMember[]).map((x) => x.user_id)
      const p = await supabase.from('profiles').select('*').in('id', ids)
      if (p.error) throw p.error
      return {
        household: h.data as Household,
        members: m.data as HouseholdMember[],
        profiles: p.data as Profile[],
      }
    },
  })

  const value = useMemo<HouseholdState>(() => {
    // Si dos miembros tienen el mismo color, el segundo se muestra con otro para distinguirlos
    const used = new Set<string>()
    const ordered = (q.data?.members ?? []).map((m) => (q.data?.profiles ?? []).find((p) => p.id === m.user_id)).filter(Boolean) as Profile[]
    const profiles = ordered.map((p) => {
      const color = used.has(p.color) ? FALLBACK_COLORS.find((c) => !used.has(c)) ?? p.color : p.color
      used.add(color)
      return { ...p, color }
    })
    const byId = new Map(profiles.map((p) => [p.id, p]))
    const members = (q.data?.members ?? []).map((m) => ({ ...m, profile: byId.get(m.user_id) ?? null }))
    return {
      household: q.data?.household ?? null,
      members,
      myRole: members.find((m) => m.user_id === user?.id)?.role ?? null,
      profileById: (id) => (id ? byId.get(id) ?? null : null),
      loading: q.isLoading,
      error: q.error,
      refetch: () => void q.refetch(),
    }
  }, [q.data, q.isLoading, q.error, q, user?.id])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useHousehold(): HouseholdState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useHousehold fuera de HouseholdProvider')
  return v
}

/** Para páginas que ya garantizan que existe un espacio */
export function useHouseholdId(): string {
  const { household } = useHousehold()
  if (!household) throw new Error('Sin espacio')
  return household.id
}
