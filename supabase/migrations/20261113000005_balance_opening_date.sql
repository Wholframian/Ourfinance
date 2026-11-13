-- =============================================================================
-- OURFINANCE · 0005 · El saldo inicial solo cuenta a partir de su fecha
-- Corrige la evolución del patrimonio: antes de opening_date la cuenta no existía.
-- =============================================================================
create or replace function public.account_balances(p_household uuid, p_at date default null)
returns table (account_id uuid, balance_cents bigint)
language sql stable
set search_path = ''
as $$
  select a.id,
         (case when p_at is null or a.opening_date <= p_at then a.opening_balance_cents else 0 end
          + coalesce(sum(
              public.tx_effect_on_account(t.type, t.amount_cents, t.account_id, t.to_account_id, a.id)
            ), 0))::bigint
  from public.accounts a
  left join public.transactions t
    on (t.account_id = a.id or t.to_account_id = a.id)
   and (p_at is null or t.occurred_on <= p_at)
  where a.household_id = p_household
  group by a.id, a.opening_balance_cents, a.opening_date;
$$;
