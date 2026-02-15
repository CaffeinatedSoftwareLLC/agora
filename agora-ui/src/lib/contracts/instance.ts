export type RegistrationPolicy = 'open' | 'invite_only' | 'approval';

export interface InstanceStatus {
  initialized: boolean;
  registrationPolicy: RegistrationPolicy;
  instanceName: string;
}
