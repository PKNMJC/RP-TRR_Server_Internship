import { Injectable, UnauthorizedException } from '@nestjs/common';

export interface LineAuthUrlResponse {
  auth_url: string;
  client_id: string;
  redirect_uri: string;
  state: string;
}

export interface LineCallbackResponse {
  access_token: string;
  user_id: string;
}

export interface LineUserProfile {
  displayName: string;
  userId: string;
  pictureUrl?: string;
  statusMessage?: string;
}

@Injectable()
export class LineOAuthService {
  private readonly lineAuthEndpoint = 'https://api.line.me/oauth2/v2.1/authorize';
  private readonly lineTokenEndpoint = 'https://api.line.me/oauth2/v2.1/token';
  private readonly lineTokenInfoEndpoint = 'https://api.line.me/v2/oauth/tokeninfo';
  private readonly lineProfileEndpoint = 'https://api.line.me/v2/profile';

  constructor() {}

  /**
   * Generate LINE OAuth authorization URL
   * @returns LineAuthUrlResponse containing auth_url, client_id, redirect_uri, and state
   */
  generateAuthUrl(): LineAuthUrlResponse {
    const clientId = process.env.LINE_CHANNEL_ID || '';
    const redirectUri = this.getRedirectUri();
    const state = this.generateState();

    // Debug: Verify env variables are loaded
    this.logDebug('LINE LOGIN DEBUG', {
      channelId: process.env.LINE_CHANNEL_ID,
      redirectUri: process.env.LINE_REDIRECT_URI,
    });

    if (!clientId) {
      throw new Error('LINE credentials not configured: LINE_CHANNEL_ID is missing');
    }

    const authUrl = new URL(this.lineAuthEndpoint);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', clientId);
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('state', state);
    authUrl.searchParams.append('scope', 'profile openid');

    console.log('[LINE Auth] Generated authorization URL:', {
      clientId,
      redirectUri,
      state: state.substring(0, 5) + '...',
    });
    this.logDebug('LINE LOGIN DEBUG', { finalRedirectUri: redirectUri });

    return {
      auth_url: authUrl.toString(),
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    };
  }

  /**
   * Exchange authorization code for access token
   * @throws UnauthorizedException if exchange fails
   */
  async exchangeCodeForToken(code: string): Promise<LineCallbackResponse> {
    const clientId = process.env.LINE_CHANNEL_ID || '';
    const clientSecret = process.env.LINE_CHANNEL_SECRET || '';
    const redirectUri = this.getRedirectUri();

    // Verify all env variables before token exchange
    this.logDebug('TOKEN EXCHANGE DEBUG', {
      clientId,
      redirectUri,
      clientSecretExists: !!clientSecret,
    });

    if (!clientId || !clientSecret) {
      throw new Error('LINE credentials not configured');
    }

    console.log('[LINE Auth] Exchanging authorization code for access token');
    console.log('[LINE Auth] Using redirect_uri:', redirectUri);

    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });

    try {
      const response = await fetch(this.lineTokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tokenParams.toString(),
      });

      const responseData = await response.json();

      if (!response.ok) {
        console.error('[LINE Auth] ❌ TOKEN EXCHANGE FAILED');
        console.error('[LINE Auth] HTTP Status:', response.status);
        console.error('[LINE Auth] Error response:', JSON.stringify(responseData, null, 2));

        // Check for redirect_uri mismatch specifically
        if (responseData.error === 'invalid_grant' && 
            responseData.error_description?.includes('redirect_uri')) {
          console.error('[LINE Auth] 🔴 REDIRECT_URI MISMATCH DETECTED!');
          console.error('[LINE Auth] Backend is using:', redirectUri);
          console.error('[LINE Auth] LINE Console has a DIFFERENT Callback URL registered!');
          throw new UnauthorizedException(
            `redirect_uri mismatch. Backend: "${redirectUri}". Update LINE Console Callback URL to match.`
          );
        }

        throw new UnauthorizedException(
          `LINE API error: ${responseData.error || 'Unknown error'}`
        );
      }

      console.log('[LINE Auth] ✅ Token exchange successful');
      return {
        access_token: responseData.access_token,
        user_id: responseData.user_id,
      };
    } catch (error: any) {
      console.error('[LINE Auth] Error exchanging code:', error.message);
      throw error instanceof UnauthorizedException 
        ? error 
        : new UnauthorizedException(`Failed to authenticate with LINE: ${error.message}`);
    }
  }

  /**
   * Get LINE user ID from access token
   * @throws UnauthorizedException if token verification fails
   */
  async getUserId(accessToken: string): Promise<string> {
    try {
      const response = await fetch(this.lineTokenInfoEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          access_token: accessToken,
        }).toString(),
      });

      if (!response.ok) {
        throw new UnauthorizedException('Failed to verify LINE access token');
      }

      const data = await response.json();
      if (!data.user_id) {
        throw new UnauthorizedException('No user_id in LINE token response');
      }

      return data.user_id;
    } catch (error: any) {
      console.error('[LINE Auth] Error getting LINE user ID:', error.message);
      throw error instanceof UnauthorizedException 
        ? error 
        : new UnauthorizedException('Failed to get LINE user ID');
    }
  }

  /**
   * Get LINE user profile information
   * @returns LineUserProfile or default profile if request fails
   */
  async getUserProfile(accessToken: string): Promise<LineUserProfile> {
    try {
      const response = await fetch(this.lineProfileEndpoint, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        console.warn('[LINE Auth] Failed to get LINE profile, using default');
        return { displayName: 'LINE User', userId: '' };
      }

      return await response.json();
    } catch (error) {
      console.error('[LINE Auth] Error getting LINE profile:', error);
      return { displayName: 'LINE User', userId: '' };
    }
  }

  /**
   * Verify that redirect_uri matches what's configured in env
   * @returns true if redirect_uri is properly configured
   */
  verifyRedirectUri(): boolean {
    const redirectUri = process.env.LINE_REDIRECT_URI;
    
    if (!redirectUri) {
      console.warn('[LINE Auth] LINE_REDIRECT_URI not configured in .env');
      return false;
    }

    // Basic validation
    if (!redirectUri.startsWith('https://')) {
      console.warn('[LINE Auth] redirect_uri must use https://');
      return false;
    }

    if (redirectUri.endsWith('/')) {
      console.warn('[LINE Auth] redirect_uri should not end with /');
      return false;
    }

    return true;
  }

  /**
   * Private helper methods
   */

  private getRedirectUri(): string {
    return process.env.LINE_REDIRECT_URI || 'https://rp-trr-client-internship.vercel.app/callback';
  }

  private generateState(): string {
    return Math.random().toString(36).substring(7);
  }

  private logDebug(label: string, data: Record<string, any>): void {
    console.log(`[🔴 ${label}] ==========================================`);
    Object.entries(data).forEach(([key, value]) => {
      console.log(`[🔴 ${label}] ${key}:`, value);
    });
    console.log(`[🔴 ${label}] ==========================================`);
  }
}
