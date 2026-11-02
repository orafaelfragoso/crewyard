export const SECRET_SERVICE = 'crewyard';

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export const systemSecretStore: SecretStore = {
  get: (name) => Bun.secrets.get({ service: SECRET_SERVICE, name }),
  set: (name, value) => Bun.secrets.set({ service: SECRET_SERVICE, name, value }),
  delete: (name) => Bun.secrets.delete({ service: SECRET_SERVICE, name }),
};

export function createMemorySecretStore(initial: Record<string, string> = {}): SecretStore & { names(): string[] } {
  const values = new Map(Object.entries(initial));
  return {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => values.delete(name),
    names: () => [...values.keys()],
  };
}
