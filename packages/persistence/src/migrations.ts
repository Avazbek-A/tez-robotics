export const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: "001_init",
    sql: `
      create table if not exists robots (
        id text primary key,
        last_state jsonb not null,
        updated_at timestamptz not null
      );

      create table if not exists transport_orders (
        id text primary key,
        pickup_node text,
        drop_node text,
        status text,
        robot_id text,
        retries int,
        created_at timestamptz,
        updated_at timestamptz
      );

      create table if not exists transport_order_history (
        id bigserial primary key,
        order_id text not null,
        at timestamptz not null,
        status text not null,
        robot_id text,
        note text
      );

      create table if not exists missions (
        id text primary key,
        order_id text,
        robot_id text,
        node_ids jsonb,
        created_at timestamptz
      );

      create table if not exists state_snapshots (
        id bigserial primary key,
        at timestamptz not null,
        snapshot jsonb not null
      );

      create table if not exists kpi_snapshots (
        id bigserial primary key,
        at timestamptz not null,
        orders_per_hour double precision,
        avg_cycle_ms double precision,
        utilization double precision
      );

      create index if not exists state_snapshots_at_idx on state_snapshots (at);
      create index if not exists transport_order_history_order_id_idx on transport_order_history (order_id);
    `,
  },
];
