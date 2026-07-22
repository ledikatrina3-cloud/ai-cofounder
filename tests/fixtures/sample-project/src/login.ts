// Чистый файл — тут проблем нет.

export interface LoginRequest {
  email: string;
  password: string;
}

export async function login(req: LoginRequest): Promise<{ token: string }> {
  if (!req.email.includes('@')) throw new Error('invalid email');
  if (req.password.length < 8) throw new Error('password too short');
  return { token: `token-for-${req.email}` };
}
