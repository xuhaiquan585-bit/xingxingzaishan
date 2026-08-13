CREATE FUNCTION app.prevent_issued_qr_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.issue_status = 'issued' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Issued QR codes are immutable.',
      CONSTRAINT = 'qr_codes_issued_immutable';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.issue_status = 'issued'
     AND NEW.issue_status IS DISTINCT FROM 'issued' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Issued QR codes are immutable.',
      CONSTRAINT = 'qr_codes_issued_immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER qr_codes_prevent_issued_mutation
BEFORE DELETE OR UPDATE OF issue_status ON app.qr_codes
FOR EACH ROW
EXECUTE FUNCTION app.prevent_issued_qr_mutation();

CREATE FUNCTION app.prevent_qr_codes_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = 'Issued QR codes are immutable.',
    CONSTRAINT = 'qr_codes_issued_immutable';
  RETURN NULL;
END;
$$;

CREATE TRIGGER qr_codes_prevent_truncate
BEFORE TRUNCATE ON app.qr_codes
FOR EACH STATEMENT
EXECUTE FUNCTION app.prevent_qr_codes_truncate();
