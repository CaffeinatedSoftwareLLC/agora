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

export interface AuthResponse {
  user: User;
  accessToken: string;
}

export interface PendingResponse {
  user: { id: string; username: string };
  status: 'pending';
}
