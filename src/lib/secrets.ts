import { 
  SecretsManagerClient, 
  GetSecretValueCommand 
} from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});
const SECRET_NAME = process.env.SECRET_NAME;

interface SftpCredentials {
  host: string;
  port: number;
  username: string;
  auth: {
    type: 'privateKey' | 'password';
    privateKey?: string;
    passphrase?: string;
    fallbackPassword?: string;
  };
  knownHosts?: string;
}

export async function getCredentials(): Promise<SftpCredentials> {
  if (!SECRET_NAME) {
    throw new Error('SECRET_NAME environment variable is required');
  }

  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: SECRET_NAME
    })
  );

  if (!response.SecretString) {
    throw new Error('Secret value is empty');
  }

  const credentials: SftpCredentials = JSON.parse(response.SecretString);

  // Validate required fields
  if (!credentials.host || !credentials.username || !credentials.auth) {
    throw new Error('Invalid secret format: missing required fields');
  }

  return {
    ...credentials,
    port: credentials.port || 22
  };
}
