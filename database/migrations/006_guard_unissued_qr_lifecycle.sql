ALTER TABLE app.qr_codes
  ADD CONSTRAINT qr_codes_issued_lifecycle_chk
  CHECK (
    issue_status = 'issued'
    OR lifecycle_status = 'unactivated'
  ) NOT VALID;
