DO $account_id_audit$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM app.accounts
    WHERE id !~ '^ACC[0-9]+$'
  ) THEN
    RAISE EXCEPTION 'Existing account IDs are not sequence-compatible.'
      USING ERRCODE = '23514';
  END IF;
END
$account_id_audit$;

CREATE SEQUENCE app.account_id_seq
  AS bigint
  INCREMENT BY 1
  MINVALUE 1
  NO MAXVALUE
  START WITH 1
  CACHE 1;

SELECT setval(
  'app.account_id_seq',
  greatest(
    coalesce((
      SELECT max(substring(id FROM 4)::bigint) + 1
      FROM app.accounts
    ), 1),
    1
  ),
  false
);
