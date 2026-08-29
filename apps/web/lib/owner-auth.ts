export type OwnerAuthConfig = {
  required: boolean;
  username?: string;
  password?: string;
};

export function ownerAuthConfig(env: NodeJS.ProcessEnv = process.env): OwnerAuthConfig {
  return {
    required: env.OWNER_AUTH_REQUIRED === 'true',
    username: env.OWNER_AUTH_USERNAME || undefined,
    password: env.OWNER_AUTH_PASSWORD || undefined,
  };
}

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function validOwnerBasicAuthorization(
  authorization: string | null,
  config: OwnerAuthConfig,
) {
  if (!config.required) return true;
  if (!config.username || !config.password || !authorization?.startsWith('Basic ')) return false;

  try {
    const decoded = atob(authorization.slice('Basic '.length));
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    return (
      constantTimeEqual(decoded.slice(0, separator), config.username) &&
      constantTimeEqual(decoded.slice(separator + 1), config.password)
    );
  } catch {
    return false;
  }
}
