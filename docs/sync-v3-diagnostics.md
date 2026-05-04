# sync-v3 диагностика

Готовые SQL-запросы для понимания «что у этого клиента / устройства не так?». Запускать на staging postgres:

```bash
ssh root@prod 'docker compose -f /root/clo/docker-compose.yml exec -T postgres psql -U chatview -d chatview'
```

## Кто сейчас онлайн

```sql
-- web-клиенты с активной WS-сессией
select client_id,
       user_agent,
       ip,
       device_memory_gb,
       connected_at,
       last_seen_at,
       now() - last_seen_at as idle_for
from v3_client_sessions
where disconnected_at is null
order by last_seen_at desc;

-- агенты онлайн (это другой канал — не WS, а HTTP append + runtimes)
select a.hostname, a.version, r.runtime_id, r.last_seen_at
from agent_runtimes r
join agents a on a.id = r.agent_id
where r.status = 'active'
order by r.last_seen_at desc;
```

## Хронология одной сессии

```sql
-- замени client_id
\set cid '''c-abc123'''

-- последние 50 событий
select created_at,
       level,
       event,
       view_id,
       duration_ms,
       bytes,
       payload
from v3_sync_events
where client_id = :cid
order by created_at desc
limit 50;
```

## Что сломано прямо сейчас

```sql
-- последние 30 минут с warn/error
select created_at, client_id, view_id, event, payload
from v3_sync_events
where level in ('warn', 'error')
  and created_at > now() - interval '30 minutes'
order by created_at desc
limit 100;

-- top-10 проблемных клиентов
select client_id,
       count(*) filter (where level = 'error') as errors,
       count(*) filter (where level = 'warn')  as warns,
       max(created_at) as last
from v3_sync_events
where created_at > now() - interval '1 day'
  and level in ('warn', 'error')
group by client_id
order by errors desc, warns desc
limit 10;
```

## Сколько каждый клиент скачал

```sql
-- bytes / events за последние сутки, на клиента
select
  client_id,
  count(*) filter (where event = 'snapshot.sent') as snapshots,
  count(*) filter (where event = 'batch.sent')   as batches,
  pg_size_pretty(coalesce(sum(bytes), 0))         as total_bytes,
  max(created_at)                                  as last_activity
from v3_sync_events
where created_at > now() - interval '1 day'
  and event in ('snapshot.sent', 'batch.sent', 'history.range')
group by client_id
order by sum(bytes) desc nulls last;
```

## Время отклика (p95) для snapshot и history.range

```sql
select event,
       count(*),
       (percentile_cont(0.5) within group (order by duration_ms))::int as p50_ms,
       (percentile_cont(0.95) within group (order by duration_ms))::int as p95_ms,
       max(duration_ms) as max_ms
from v3_sync_events
where created_at > now() - interval '1 day'
  and duration_ms is not null
group by event
order by p95_ms desc;
```

## Посмотреть стейт подписок

```sql
-- по каждой подписке: текущий cursor + сколько байт ещё осталось докачать
-- (last_event лежит в v3_sync_events.payload->>'bytesRemaining' от последнего batch.sent)
select v.client_id,
       v.view_id,
       c.cursor,
       v.spec_hash,
       v.updated_at,
       (select bytes_remaining from (
         select payload->>'bytesRemaining' as bytes_remaining
         from v3_sync_events
         where client_id = v.client_id and view_id = v.view_id
           and event in ('batch.sent', 'view.idle')
         order by created_at desc
         limit 1
       ) x) as last_known_bytes_remaining
from client_views v
left join client_view_cursors c
  on c.client_id = v.client_id and c.view_id = v.view_id
order by v.updated_at desc;
```

## Сессии за сутки (длительность)

```sql
select client_id,
       connected_at,
       coalesce(disconnected_at, now()) - connected_at as duration,
       close_code,
       close_reason
from v3_client_sessions
where connected_at > now() - interval '1 day'
order by connected_at desc;
```

## Ретеншн (сколько строк в логах)

```sql
select count(*) as events,
       pg_size_pretty(pg_total_relation_size('v3_sync_events'::regclass)) as size,
       min(created_at) as oldest,
       max(created_at) as newest
from v3_sync_events;
```

Если `v3_sync_events` начинает раздуваться, можно ввести retention:

```sql
-- удалить debug+info старше 7 дней; warn+error — храним 30 дней
delete from v3_sync_events
where created_at < now() - interval '7 days'
  and level in ('debug', 'info');

delete from v3_sync_events
where created_at < now() - interval '30 days';
```

(Поставь это в cron / pg_cron / простой `setInterval` в server.ts если станет нужно.)
