import type { FormEvent } from "react";
import type { AuthState } from "./app-types";

type AuthPageProps = {
  authState: AuthState;
  authConfigured: boolean;
  authToken: string;
  authError: string;
  authBusy: boolean;
  onTokenChange: (value: string) => void;
  onLogin: (event: FormEvent<HTMLFormElement>) => void;
};

export function AuthPage({
  authState,
  authConfigured,
  authToken,
  authError,
  authBusy,
  onTokenChange,
  onLogin,
}: AuthPageProps) {
  return (
    <div className="auth-page">
      <form className="auth-panel" onSubmit={onLogin}>
        <div className="auth-brand">Chatview</div>
        <label className="auth-label" htmlFor="chatview-token">
          Token
        </label>
        <input
          id="chatview-token"
          className="auth-input"
          type="password"
          value={authToken}
          onChange={(event) => onTokenChange(event.target.value)}
          placeholder={authState === "checking" ? "Checking session" : "Enter token"}
          autoFocus
          autoComplete="current-password"
          disabled={authState === "checking" || authBusy || !authConfigured}
        />
        {authError && <div className="auth-error">{authError}</div>}
        <button className="auth-button" disabled={authState === "checking" || authBusy || !authConfigured || !authToken.trim()}>
          {authBusy ? "Signing in" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
