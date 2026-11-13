-- =============================================================================
-- OURFINANCE · 0004 · Storage para justificantes
-- Bucket privado 'attachments'. Ruta: {household_id}/{user_id}/{fichero}
--   * Subir: solo en tu carpeta y en un espacio al que perteneces.
--   * Leer: tus propios ficheros, o los asociados a un movimiento que puedes ver
--     (la consulta a public.attachments aplica su RLS).
--   * Borrar: solo tus propios ficheros.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 10485760,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy attachments_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and private.is_member(((storage.foldername(name))[1])::uuid)
  );

create policy attachments_read on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and (
      (storage.foldername(name))[2] = (select auth.uid())::text
      or exists (select 1 from public.attachments a where a.storage_path = name)
    )
  );

create policy attachments_remove on storage.objects for delete to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );
