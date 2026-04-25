export enum Role {
  EMPLOYEE = 'employee',
  MANAGER = 'manager',
  ADMIN = 'admin',
  HCM = 'hcm',
}

export interface Actor {
  role: Role;
  id: string | null;
}
