declare module '@protontech/crypto' {
  export interface CryptoApiInterface {}

  export interface PublicKeyReference {
    readonly _idx: number;
  }

  export interface PrivateKeyReference extends PublicKeyReference {
    readonly _dummyType?: 'private';
  }

  export interface PrivateKeyReferenceV4 extends PrivateKeyReference {}
  export interface PrivateKeyReferenceV6 extends PrivateKeyReference {}

  export interface SessionKey {
    data: Uint8Array;
    algorithm?: string;
  }

  export enum VERIFICATION_STATUS {
    NOT_SIGNED = 0,
    SIGNED_AND_VALID = 1,
    SIGNED_AND_INVALID = 2,
  }
}
