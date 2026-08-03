ALTER TABLE app.products
  DROP CONSTRAINT products_buy_type_chk,
  ADD CONSTRAINT products_buy_type_chk
    CHECK (buy_type IN ('miniapp_order', 'copy_link'));
