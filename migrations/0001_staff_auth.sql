-- Staff authentication tables owned by Better Auth (see scripts/auth-schema.ts).
-- Column names follow the field mapping in src/auth/staff-auth.ts.

CREATE TABLE auth_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  two_factor_enabled boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions (user_id);

CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX auth_accounts_user_id_idx ON auth_accounts (user_id);

CREATE TABLE auth_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications (identifier);

CREATE TABLE auth_two_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret text NOT NULL,
  backup_codes text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  verified boolean DEFAULT true,
  failed_verification_count integer DEFAULT 0,
  locked_until timestamptz
);
CREATE INDEX auth_two_factors_secret_idx ON auth_two_factors (secret);
CREATE INDEX auth_two_factors_user_id_idx ON auth_two_factors (user_id);
