-- Invoice numbers are sequential (INV-<year>-<sequence>); gaps can occur if a transaction rolls back.
CREATE SEQUENCE invoice_number_seq START 1001;
