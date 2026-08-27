-- 0001_init rollback. Drop order is reverse-dependency; enums last.

DROP TABLE IF EXISTS purge_log;
DROP TABLE IF EXISTS router_jobs;
DROP TABLE IF EXISTS worksheet_contributions;
DROP TABLE IF EXISTS worksheet_lines;
DROP TABLE IF EXISTS worksheets;
DROP TABLE IF EXISTS dispositions;
DROP TABLE IF EXISTS check_results;
DROP TABLE IF EXISTS field_corrections;
DROP TABLE IF EXISTS extracted_fields;
DROP TABLE IF EXISTS layout_spans;
DROP TABLE IF EXISTS pages;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS source_files;
DROP TABLE IF EXISTS bundle_taxpayers;
DROP TABLE IF EXISTS bundles;
DROP TABLE IF EXISTS taxpayers;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

DROP TYPE IF EXISTS job_state;
DROP TYPE IF EXISTS disposition_kind;
DROP TYPE IF EXISTS check_outcome;
DROP TYPE IF EXISTS check_severity;
DROP TYPE IF EXISTS review_reason;
DROP TYPE IF EXISTS document_status;
DROP TYPE IF EXISTS page_route;
DROP TYPE IF EXISTS bundle_status;
DROP TYPE IF EXISTS user_role;
