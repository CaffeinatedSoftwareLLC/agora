export interface LoginRequest { email: string; password: string; }

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  inviteCode?: string;
}

export interface User {
  id: string;
  username: string;
  isInstanceAdmin?: boolean;
}

/** The UI asks for a cookie session, so the token itself is never in the body. */
export interface AuthResponse {
  user: User;
}

export interface PendingResponse {
  user: { id: string; username: string };
  status: 'pending';
}
