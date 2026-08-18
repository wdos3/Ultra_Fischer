create table if not exists public.auth_rate_limits (
  key text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0)
);

revoke all on table public.auth_rate_limits from anon, authenticated;

create or replace function public.consume_auth_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  now_value timestamptz := clock_timestamp();
  current_count integer;
begin
  if p_key is null or length(p_key) < 16 or p_limit < 1 or p_window_seconds < 1 then
    return false;
  end if;

  insert into public.auth_rate_limits(key, window_started_at, request_count)
  values (p_key, now_value, 1)
  on conflict (key) do update
    set window_started_at = case
      when public.auth_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= now_value
        then excluded.window_started_at
      else public.auth_rate_limits.window_started_at
    end,
    request_count = case
      when public.auth_rate_limits.window_started_at + make_interval(secs => p_window_seconds) <= now_value
        then 1
      else public.auth_rate_limits.request_count + 1
    end
  returning request_count into current_count;

  return current_count <= p_limit;
end;
$$;

revoke all on function public.consume_auth_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_auth_rate_limit(text, integer, integer) to service_role;

create index if not exists auth_rate_limits_window_started_at_idx
  on public.auth_rate_limits(window_started_at);
