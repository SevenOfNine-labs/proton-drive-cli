/**
 * Type definitions for the Proton account key material (GET /core/v4/users
 * and /core/v4/addresses).
 */

/**
 * Address key from API
 */
export interface AddressKey {
  ID: string;
  Version: number;
  Primary: number; // 1 = primary, 0 = not primary
  Flags: number;
  PrivateKey: string; // Armored encrypted private key
  Token: string | null; // Key token (encrypted with primary key)
  Signature: string | null; // Signature of the key
  Activation: string | null; // Activation token
}

/**
 * Address from API
 */
export interface Address {
  ID: string;
  Email: string;
  Status: number;
  Type: number;
  Order: number;
  Priority: number;
  Keys: AddressKey[];
}

/**
 * User key from API
 */
export interface UserKey {
  ID: string;
  Version: number;
  Primary: number;
  PrivateKey: string; // Armored encrypted private key
  Token: string | null;
  Fingerprint: string;
  Activation: string | null;
}

/**
 * User info from API
 */
export interface User {
  ID: string;
  Name: string;
  Email: string;
  Keys: UserKey[];
}
