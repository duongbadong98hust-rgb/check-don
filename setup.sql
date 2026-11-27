-- ============================================================
-- CHECK ĐƠN: chạy 1 lần trong Supabase > SQL Editor > Run
-- (Chạy lại nhiều lần cũng không sao.)
-- ============================================================

-- 1) Bảng lưu đơn đã đóng
create table if not exists public.orders (
  id            bigserial primary key,
  tracking      text        not null,                 -- mã vận đơn
  customer      text        not null default '',      -- tên khách
  customer_norm text        not null default '',      -- tên không dấu, để tìm kiếm
  packed_at     timestamptz not null default now(),   -- giờ đóng hàng (giờ máy chủ)
  photos        jsonb       not null default '[]',    -- [{ "path": "...", "size": 12345 }]
  total_bytes   bigint      not null default 0
);
create index if not exists orders_tracking_idx  on public.orders (tracking);
create index if not exists orders_packed_at_idx on public.orders (packed_at desc);

-- Chỉ tài khoản đã đăng nhập mới đọc/ghi được
grant select, insert, update, delete on public.orders to authenticated;
grant usage, select on sequence public.orders_id_seq to authenticated;
revoke all on public.orders from anon;
alter table public.orders enable row level security;
drop policy if exists "orders_logged_in" on public.orders;
create policy "orders_logged_in" on public.orders
  for all to authenticated using (true) with check (true);

-- 2) Giờ máy chủ (để giờ đóng hàng không phụ thuộc giờ trên điện thoại)
create or replace function public.server_now()
returns timestamptz language sql stable as $$ select now() $$;

-- 3) Tổng dung lượng ảnh đang lưu (byte)
create or replace function public.storage_used()
returns bigint language sql stable security invoker as $$
  select coalesce(sum(total_bytes), 0)::bigint from public.orders
$$;

revoke execute on function public.server_now()   from anon, public;
revoke execute on function public.storage_used() from anon, public;
grant  execute on function public.server_now()   to authenticated;
grant  execute on function public.storage_used() to authenticated;

-- 4) Kho ảnh (riêng tư, mỗi ảnh tối đa 1MB, chỉ nhận JPEG)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

drop policy if exists "photos_read"   on storage.objects;
drop policy if exists "photos_insert" on storage.objects;
drop policy if exists "photos_delete" on storage.objects;
create policy "photos_read"   on storage.objects for select to authenticated using (bucket_id = 'photos');
create policy "photos_insert" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
create policy "photos_delete" on storage.objects for delete to authenticated using (bucket_id = 'photos');

-- 5) Đơn đi (quét khi giao cho shipper) — thêm ngày 27/11/2026
create table if not exists public.dispatches (
  id         bigserial primary key,
  tracking   text        not null,
  customer   text        not null default '',
  day        date        not null default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),  -- ngày đi đơn (giờ VN)
  scanned_at timestamptz not null default now(),
  unique (tracking, day)                                     -- 1 mã chỉ 1 lần mỗi ngày
);
create index if not exists dispatches_day_idx on public.dispatches (day desc, scanned_at desc);
grant select, insert, update, delete on public.dispatches to authenticated;
grant usage, select on sequence public.dispatches_id_seq to authenticated;
revoke all on public.dispatches from anon;
alter table public.dispatches enable row level security;
drop policy if exists "dispatches_logged_in" on public.dispatches;
create policy "dispatches_logged_in" on public.dispatches
  for all to authenticated using (true) with check (true);

-- Ngày hôm nay theo giờ Việt Nam
create or replace function public.vn_today()
returns date language sql stable as $$ select (now() at time zone 'Asia/Ho_Chi_Minh')::date $$;
revoke execute on function public.vn_today() from anon, public;
grant  execute on function public.vn_today() to authenticated;
