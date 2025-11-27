/**
 * ========================================
 * DMAP - Google Drive API 관리 모듈
 * ========================================
 * 
 * 용도:
 *   - Google Drive와의 파일 동기화 담당
 *   - OAuth 2.0 인증 관리
 *   - DXF, 사진, 메타데이터 업로드/다운로드
 * 
 * 주요 기능:
 *   1. Google Identity Services OAuth 인증
 *   2. 액세스 토큰 자동 갱신 (localStorage 캐싱)
 *   3. DXF 파일 목록 조회/필터링
 *   4. 파일 업로드/다운로드 (멀티파트)
 *   5. 메타데이터 JSON 관리
 *   6. 사진 파일 삭제
 * 
 * 최적화:
 *   - 토큰 localStorage 캐싱 (만료 1분 전 자동 갱신)
 *   - 인증 재시도 로직 (401/403 자동 처리)
 *   - fetchWithAuth 통합 메서드
 * 
 * 의존성:
 *   - Google Identity Services (GIS)
 *   - Google Drive API v3
 * 
 * 버전: 1.0.0
 * 최종 수정: 2025-11-18
 * ========================================
 */

/**
 * Google Drive API 관리 클래스
 * - OAuth 인증 및 토큰 관리
 * - 파일 업로드/다운로드
 * - 메타데이터 동기화
 */
class GoogleDriveManager {
    constructor() {
        // OAuth 설정
        this.clientId = '906332453523-or8l93395kamm6sipv4hogn93i2clj3k.apps.googleusercontent.com';
        this.apiKey = 'AIzaSyAMBSJ39taPtfZgkIocKzIx3rutrCcaMaI';
        this.scopes = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive';
        
        // 대상 폴더 ID (제공된 Google Drive 폴더)
        this.targetFolderId = '18NRsrVaR2OUiU4mf5zMseoFM-fij0FWX';
        
        // 액세스 토큰
        this.accessToken = null;
        this.tokenExpiresAt = null;
        this.tokenStorageKey = 'dmap:gdrive-token';
        
        // Token Client
        this.tokenClient = null;
        
        // 초기화 완료 여부
        this.initialized = false;
    }

    notifyAuthState() {
        try {
            window.dispatchEvent(new CustomEvent('drive-auth-changed', {
                detail: { authenticated: this.isAccessTokenValid() }
            }));
        } catch (error) {
            console.warn('⚠️ 인증 상태 이벤트 전송 실패:', error);
        }
    }

    async requestNewToken(options = {}) {
        if (!this.tokenClient) {
            throw new Error('TokenClient가 초기화되지 않았습니다');
        }
        const { prompt = 'none' } = options;

        return new Promise((resolve, reject) => {
            this.tokenClient.callback = (response) => {
                if (response.error) {
                    reject(response);
                    return;
                }
                this.persistToken(response.access_token, response.expires_in);
                this.initialized = true;
                resolve(response.access_token);
            };

            try {
                this.tokenClient.requestAccessToken({ prompt });
            } catch (error) {
                reject(error);
            }
        });
    }

    async ensureAuthenticated(options = {}) {
        const { allowInteractive = true, silentOnly = false, suppressLogout = false } = options;

        if (this.isAccessTokenValid()) {
            return true;
        }

        if (!this.tokenClient) {
            throw new Error('Google Drive 로그인이 필요합니다. 페이지를 새로고침하고 다시 시도해주세요.');
        }

        const prompts = silentOnly
            ? ['none']
            : allowInteractive
                ? ['none', 'consent']
                : ['none'];

        for (const prompt of prompts) {
            try {
                await this.requestNewToken({ prompt });
                if (this.isAccessTokenValid()) {
                    return true;
                }
            } catch (error) {
                console.warn(`⚠️ 토큰 갱신 실패 (prompt=${prompt})`, error);
            }
        }

        if (!suppressLogout) {
            this.logout();
            if (typeof showToast === 'function') {
                showToast('Google Drive 인증이 만료되었습니다. 다시 로그인해주세요.');
            }
        }

        throw new Error('Google Drive 인증이 필요합니다. 다시 로그인해주세요.');
    }

    isAuthStatus(status) {
        return status === 401 || status === 403;
    }

    async forceTokenRefresh() {
        this.clearStoredToken();
        try {
            await this.ensureAuthenticated({ allowInteractive: true, suppressLogout: true });
            this.notifyAuthState();
            return true;
        } catch (error) {
            console.warn('⚠️ 토큰 강제 갱신 실패:', error);
            this.logout();
            return false;
        }
    }

    async handleAuthRetry({ retrying = false, retryCallback, operation = '요청' }) {
        if (typeof retryCallback !== 'function') {
            throw new Error(`${operation} 중 인증 오류가 발생했습니다.`);
        }

        if (!retrying) {
            const refreshed = await this.forceTokenRefresh();
            if (refreshed) {
                return retryCallback(true);
            }
        }

        throw new Error(`${operation}에 실패했습니다. Google Drive에 다시 로그인해주세요.`);
    }

    async fetchWithAuth(url, options = {}, config = {}) {
        const { retrying = false, operation = '요청' } = config;
        await this.ensureAuthenticated();

        const headers = {
            ...(options.headers || {}),
            'Authorization': `Bearer ${this.accessToken}`
        };

        const mergedOptions = {
            ...options,
            headers
        };

        const response = await fetch(url, mergedOptions);

        if (this.isAuthStatus(response.status)) {
            return this.handleAuthRetry({
                retrying,
                operation,
                retryCallback: () => this.fetchWithAuth(url, options, { ...config, retrying: true })
            });
        }

        return response;
    }

    /**
     * Google Identity Services 초기화
     */
    async initialize() {
        return new Promise((resolve) => {
            console.log('🔑 Google Identity Services 초기화 중...');
            
            // GIS 라이브러리가 로드될 때까지 대기
            const checkGIS = setInterval(() => {
                if (window.google && window.google.accounts) {
                    clearInterval(checkGIS);
                    
                    console.log('✅ Google Identity Services 로드됨');
                    
                    // Token Client 초기화
                    this.tokenClient = google.accounts.oauth2.initTokenClient({
                        client_id: this.clientId,
                        scope: this.scopes,
                        callback: (response) => {
                            if (response.access_token) {
                                this.accessToken = response.access_token;
                                this.initialized = true;
                                console.log('✅ Google Drive 인증 성공');
                            }
                        },
                    });
                    
                    this.restoreTokenFromStorage();
                    
                    console.log('✅ Token Client 초기화 완료');
                    resolve();
                }
            }, 100);
        });
    }

    /**
     * 사용자 인증 요청
     */
    async authenticate() {
        console.log('🔐 인증 요청 중...');
        const token = await this.requestNewToken({ prompt: 'consent' });
        console.log('✅ 인증 완료');
        return token;
    }

    persistToken(accessToken, expiresIn = 3600) {
        if (!accessToken) return;
        const expiresAt = Date.now() + (expiresIn * 1000) - 60000; // 만료 1분 전 갱신
        this.accessToken = accessToken;
        this.tokenExpiresAt = expiresAt;
        try {
            localStorage.setItem(this.tokenStorageKey, JSON.stringify({
                accessToken,
                expiresAt
            }));
            console.log(`🔒 토큰 저장됨 (만료까지 ${Math.round((expiresAt - Date.now()) / 1000)}초)`);
        } catch (error) {
            console.warn('⚠️ 토큰 저장 실패:', error);
        }
        this.notifyAuthState();
    }

    restoreTokenFromStorage() {
        try {
            const stored = localStorage.getItem(this.tokenStorageKey);
            if (!stored) return;
            const parsed = JSON.parse(stored);
            if (parsed && parsed.accessToken && parsed.expiresAt && Date.now() < parsed.expiresAt) {
                this.accessToken = parsed.accessToken;
                this.tokenExpiresAt = parsed.expiresAt;
                this.initialized = true;
                console.log('🔑 저장된 토큰 복원, 만료까지', Math.round((parsed.expiresAt - Date.now()) / 1000), '초');
                this.notifyAuthState();
                return;
            }
        } catch (error) {
            console.warn('⚠️ 저장된 토큰 로드 실패:', error);
        }
        this.clearStoredToken();
        this.notifyAuthState();
    }

    clearStoredToken() {
        this.accessToken = null;
        this.tokenExpiresAt = null;
        try {
            localStorage.removeItem(this.tokenStorageKey);
        } catch (error) {
            console.warn('⚠️ 토큰 제거 실패:', error);
        }
    }

    isAccessTokenValid() {
        return !!this.accessToken && !!this.tokenExpiresAt && Date.now() < this.tokenExpiresAt;
    }

    /**
     * 지정된 폴더에서 모든 파일 목록 가져오기
     */
    async listFiles(options = {}) {
        console.log('📂 파일 목록 조회 중...');
        console.log('폴더 ID:', this.targetFolderId);
        console.log('액세스 토큰:', this.accessToken ? '있음 (길이: ' + this.accessToken.length + ')' : '없음');

        const query = `'${this.targetFolderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,modifiedTime,mimeType)&orderBy=modifiedTime desc&key=${this.apiKey}`;

        console.log('요청 URL:', url);

        const response = await this.fetchWithAuth(url, {}, {
            operation: '파일 목록 가져오기',
            retrying: options.retrying
        });

        console.log('응답 상태:', response.status, response.statusText);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('API 오류 응답:', errorText);
            throw new Error(`파일 목록 가져오기 실패: ${response.status} ${response.statusText}\n${errorText}`);
        }

        const data = await response.json();
        
        console.log('✅ 전체 파일 수:', data.files.length);

        return data.files;
    }

    /**
     * 지정된 폴더에서 DXF 파일 목록만 가져오기
     */
    async listDxfFiles() {
        const allFiles = await this.listFiles();
        
        // .dxf 파일만 필터링
        const dxfFiles = allFiles.filter(file => 
            file.name.toLowerCase().endsWith('.dxf')
        );

        console.log(`✅ DXF 파일 ${dxfFiles.length}개 발견`);

        return dxfFiles;
    }

    /**
     * 파일 다운로드 (텍스트)
     */
    async downloadFile(fileId) {
        console.log('📥 파일 다운로드 중...');

        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${this.apiKey}`;

        const response = await this.fetchWithAuth(url, {}, {
            operation: '파일 다운로드'
        });

        if (!response.ok) {
            throw new Error(`파일 다운로드 실패: ${response.statusText}`);
        }

        console.log('✅ 다운로드 완료');
        return await response.text();
    }

    /**
     * 파일 다운로드 (Blob)
     */
    async downloadFileAsBlob(fileId) {
        console.log('📥 파일 다운로드 중 (Blob)...');

        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${this.apiKey}`;

        const response = await this.fetchWithAuth(url, {}, {
            operation: '파일 다운로드'
        });

        if (!response.ok) {
            throw new Error(`파일 다운로드 실패: ${response.statusText}`);
        }

        console.log('✅ 다운로드 완료 (Blob)');
        return await response.blob();
    }

    /**
     * 파일 업로드 (멀티파트)
     */
    async uploadFile(fileName, content, mimeType = 'text/plain') {
        console.log('📤 파일 업로드 중:', fileName);

        const metadata = {
            name: fileName,
            parents: [this.targetFolderId],
        };

        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));

        const fileBlob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
        form.append('file', fileBlob, fileName);

        const response = await this.fetchWithAuth(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
            {
                method: 'POST',
                body: form,
            },
            { operation: '파일 업로드' }
        );

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`파일 업로드 실패: ${error}`);
        }

        const result = await response.json();
        console.log('✅ 업로드 완료:', result.name);
        return result;
    }

    /**
     * 기존 파일 업데이트
     */
    async updateFile(fileId, content, mimeType = 'text/plain') {
        console.log('🔄 파일 업데이트 중...');

        const response = await this.fetchWithAuth(
            `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
            {
                method: 'PATCH',
                headers: {
                    'Content-Type': mimeType,
                },
                body: content,
            },
            { operation: '파일 업데이트' }
        );

        if (!response.ok) {
            throw new Error(`파일 업데이트 실패: ${response.statusText}`);
        }

        console.log('✅ 업데이트 완료');
        return await response.json();
    }

    /**
     * 파일 검색 (이름으로)
     */
    async findFileByName(fileName) {
        const query = `name='${fileName}' and '${this.targetFolderId}' in parents and trashed = false`;
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&key=${this.apiKey}`;

        const response = await this.fetchWithAuth(url, {}, { operation: '파일 검색' });

        if (!response.ok) {
            throw new Error(`파일 검색 실패: ${response.statusText}`);
        }

        const data = await response.json();
        return data.files.length > 0 ? data.files[0] : null;
    }

    /**
     * 이미지 업로드 (Base64에서 변환)
     */
    async uploadImage(fileName, base64Data) {
        // Base64를 Blob으로 변환
        const base64Response = await fetch(base64Data);
        const blob = await base64Response.blob();

        return this.uploadFile(fileName, blob, blob.type);
    }

    /**
     * 메타데이터 JSON 저장
     */
    async saveMetadata(dxfFileName, metadata) {
        const metadataFileName = dxfFileName.replace('.dxf', '_metadata.json');
        const metadataContent = JSON.stringify(metadata, null, 2);

        // 기존 메타데이터 파일이 있는지 확인
        const existingFile = await this.findFileByName(metadataFileName);

        if (existingFile) {
            // 업데이트
            return await this.updateFile(existingFile.id, metadataContent, 'application/json');
        } else {
            // 새로 생성
            return await this.uploadFile(metadataFileName, metadataContent, 'application/json');
        }
    }

    /**
     * 메타데이터 JSON 불러오기
     */
    async loadMetadata(dxfFileName) {
        const metadataFileName = dxfFileName.replace('.dxf', '_metadata.json');
        
        try {
            const file = await this.findFileByName(metadataFileName);
            if (file) {
                const content = await this.downloadFile(file.id);
                return JSON.parse(content);
            }
        } catch (error) {
            console.warn('메타데이터를 불러올 수 없습니다:', error);
        }

        // 메타데이터가 없으면 빈 구조 반환
        return {
            dxfFile: dxfFileName,
            photos: [],
            texts: [],
            lastModified: new Date().toISOString(),
        };
    }

    /**
     * 파일 삭제
     */
    async deleteFile(fileId) {
        const response = await this.fetchWithAuth(
            `https://www.googleapis.com/drive/v3/files/${fileId}`,
            { method: 'DELETE' },
            { operation: '파일 삭제' }
        );

        if (!response.ok) {
            throw new Error(`파일 삭제 실패: ${response.statusText}`);
        }

        return true;
    }

    /**
     * 로그아웃
     */
    logout() {
        if (this.accessToken) {
            google.accounts.oauth2.revoke(this.accessToken, () => {
                console.log('🔓 로그아웃 완료');
            });
        }
        this.clearStoredToken();
        this.initialized = false;
        this.notifyAuthState();
    }
}

// 전역 인스턴스 생성
window.driveManager = new GoogleDriveManager();

// 초기화 함수
window.initGoogleDrive = async function() {
    try {
        await window.driveManager.initialize();
        console.log('✅ Google Drive 준비 완료');
        
        const isAuthError = (error) => {
            if (!error) return false;
            const status = error.status;
            const message = (error.message || error.toString() || '').toLowerCase();
            if (status === 401 || status === 403) return true;
            return /401|403|login|로그인|token|토큰|인증|unauthorized|authorization/.test(message);
        };
        
        // 앱에서 사용할 수 있도록 전역 함수 등록
        window.authenticateGoogleDrive = async () => {
            if (window.driveManager?.isAccessTokenValid()) {
                console.log('🔁 저장된 액세스 토큰 유효함, 재인증 생략');
                return true;
            }

            try {
                await window.driveManager.authenticate();
                return true;
            } catch (error) {
                console.error('인증 실패:', error);
                return false;
            }
        };
        
        window.listDxfFiles = async () => {
            return await window.driveManager.listFiles();
        };
        
        window.downloadDxfFile = async (fileId) => {
            return await window.driveManager.downloadFile(fileId);
        };
        
        // 파일 이름으로 다운로드
        window.downloadFileByName = async (fileName) => {
            try {
                const files = await window.driveManager.listFiles();
                const file = files.find(f => f.name === fileName);
                
                if (file) {
                    return await window.driveManager.downloadFile(file.id);
                } else {
                    console.warn('⚠️ 파일을 찾을 수 없음:', fileName);
                    return null;
                }
            } catch (error) {
                console.error('❌ 파일 다운로드 실패:', error);
                return null;
            }
        };

        window.downloadFileByNameAsDataUrl = async (fileName) => {
            try {
                const files = await window.driveManager.listFiles();
                const file = files.find(f => f.name === fileName);
                
                if (!file) {
                    console.warn('⚠️ 파일을 찾을 수 없음:', fileName);
                    return null;
                }

                const blob = await window.driveManager.downloadFileAsBlob(file.id);
                return await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            } catch (error) {
                console.error('❌ 파일(DataURL) 다운로드 실패:', error);
                return null;
            }
        };
        
        // Google Drive에서 사진 파일 삭제
        window.deletePhotoFromDrive = async (photoFileName, options = {}) => {
            const { retrying = false } = options;
            try {
                console.log('🗑️ Google Drive에서 사진 삭제:', photoFileName);
                
                if (!window.driveManager) {
                    throw new Error('Google Drive Manager가 초기화되지 않았습니다');
                }
                
                await window.driveManager.ensureAuthenticated({ allowInteractive: true });
                
                // 파일 검색
                const files = await window.driveManager.listFiles();
                const fileToDelete = files.find(f => f.name === photoFileName);
                
                if (fileToDelete) {
                    console.log('   파일 발견, 삭제 중:', fileToDelete.id);
                    await window.driveManager.deleteFile(fileToDelete.id);
                    console.log('   ✅ 파일 삭제 완료');
                    return true;
                } else {
                    console.warn('   ⚠️ 파일을 찾을 수 없음:', photoFileName, '(이미 삭제되었을 수 있음)');
                    return true; // 이미 삭제된 것으로 판단하고 성공 처리
                }
            } catch (error) {
                console.error('❌ Google Drive 사진 삭제 실패:', error);
                if (!retrying && isAuthError(error)) {
                    console.log('   🔁 인증 오류 감지, 다시 로그인 시도...');
                    const reauth = await window.authenticateGoogleDrive();
                    if (reauth) {
                        return window.deletePhotoFromDrive(photoFileName, { retrying: true });
                    }
                }
                if (isAuthError(error)) {
                    showToast('로그인이 만료되었습니다. Google Drive 버튼을 눌러 다시 로그인하세요.');
                }
                throw error;
            }
        };
        
        window.saveToDrive = async (appData, dxfFileName, options = {}) => {
            const { retrying = false } = options;
            try {
                console.log('💾 Google Drive 저장 시작...');
                console.log('   파일명:', dxfFileName);
                console.log('   새 사진 개수:', appData.photos.length);
                console.log('   전체 사진 개수:', appData.allPhotos ? appData.allPhotos.length : 0);
                console.log('   텍스트 개수:', appData.texts.length);
                
                if (!window.driveManager) {
                    throw new Error('Google Drive Manager가 초기화되지 않았습니다');
                }
                
                await window.driveManager.ensureAuthenticated({ allowInteractive: true });
                
                const baseName = dxfFileName.replace(/\.dxf$/i, '');
                const ensurePhotoFileName = (photo) => {
                    if (photo.fileName && typeof photo.fileName === 'string') {
                        return photo.fileName;
                    }
                    const now = new Date();
                    const formatted = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
                    const fileName = `${baseName}_photo_${formatted}.jpg`;
                    photo.fileName = fileName;
                    return fileName;
                };
                
                // 1. 메타데이터 저장 (전체 사진 목록 사용)
                console.log('📝 메타데이터 생성 중...');
                const allPhotos = appData.allPhotos || appData.photos;
                const metadata = {
                    dxfFile: dxfFileName,
                    photos: allPhotos.map((photo) => ({
                        id: photo.id,
                        fileName: ensurePhotoFileName(photo),
                        position: { x: photo.x, y: photo.y },
                        size: { width: photo.width, height: photo.height },
                        memo: photo.memo || '',
                        uploaded: photo.uploaded || false
                    })),
                    texts: appData.texts || [],
                    lastModified: new Date().toISOString()
                };
                
                console.log('📤 메타데이터 업로드 중...');
                await window.driveManager.saveMetadata(dxfFileName, metadata);
                console.log('✅ 메타데이터 저장 완료');
                
                // 2. 새로운 사진 파일들만 업로드
                // 개별 에러 처리: 일부 사진이 실패해도 나머지는 계속 업로드
                if (appData.photos.length > 0) {
                    console.log(`📸 새 사진 업로드 시작 (${appData.photos.length}개)...`);
                    const allPhotos = appData.allPhotos || appData.photos;
                    
                    let successCount = 0;
                    let failCount = 0;
                    
                    for (let i = 0; i < appData.photos.length; i++) {
                        const photo = appData.photos[i];
                        try {
                            // allPhotos에서 이 사진의 인덱스를 찾아서 파일명 결정
                            ensurePhotoFileName(photo);
                            const photoFileName = photo.fileName;
                            
                            console.log(`   [${i + 1}/${appData.photos.length}] ${photoFileName} 업로드 중...`);
                            await window.driveManager.uploadImage(photoFileName, photo.imageData);
                            console.log(`   ✅ ${photoFileName} 업로드 완료`);
                            photo.fileName = photoFileName;
                            photo.uploaded = true;
                            successCount++;
                            
                            // 각 사진 업로드 완료 시 즉시 화면 업데이트 (마커 색상 변경: 초록색 → 빨간색)
                            // window.app이 존재하면 redraw() 호출하여 실시간 업데이트
                            if (window.app && typeof window.app.redraw === 'function') {
                                window.app.redraw();
                            }
                        } catch (error) {
                            // 개별 사진 업로드 실패 시에도 나머지 사진은 계속 업로드
                            console.error(`   ❌ ${photo.fileName || '사진'} 업로드 실패:`, error.message);
                            photo.uploaded = false; // 업로드 실패 상태 유지 (초록색 점 표시)
                            failCount++;
                            
                            // 화면 업데이트 (초록색 점으로 표시됨)
                            if (window.app && typeof window.app.redraw === 'function') {
                                window.app.redraw();
                            }
                        }
                    }
                    
                    if (failCount > 0) {
                        console.warn(`⚠️ 일부 사진 업로드 실패: 성공 ${successCount}개, 실패 ${failCount}개`);
                    } else {
                        console.log(`✅ 모든 사진 업로드 완료 (${successCount}개)`);
                    }
                } else {
                    console.log('⏭️ 업로드할 새 사진 없음');
                }
                
                console.log('✅ Google Drive 저장 완료!');
                return true;
            } catch (error) {
                console.error('❌ Google Drive 저장 실패:', error);
                console.error('   에러 상세:', error.message);
                console.error('   스택:', error.stack);
                if (!retrying && isAuthError(error)) {
                    console.log('   🔁 인증 오류 감지, 다시 로그인 시도...');
                    const reauth = await window.authenticateGoogleDrive();
                    if (reauth) {
                        return window.saveToDrive(appData, dxfFileName, { retrying: true });
                    }
                }
                throw error; // 에러를 위로 전파하여 app.js에서 처리
            }
        };
        
    } catch (error) {
        console.error('❌ Google Drive 초기화 실패:', error);
    }
};

(() => {
    const originalInitGoogleDrive = window.initGoogleDrive;
    window.driveInitPromise = null;

    window.initGoogleDrive = async () => {
        if (!window.driveInitPromise) {
            window.driveInitPromise = originalInitGoogleDrive();
        }
        return window.driveInitPromise;
    };
})();

/**
 * 토스트 메시지 표시 유틸리티
 */
function showToast(message) {
    // 기존 토스트 제거
    const existingToast = document.querySelector('.toast-message');
    if (existingToast) {
        existingToast.remove();
    }
    
    // 새 토스트 생성
    const toast = document.createElement('div');
    toast.className = 'toast-message';
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 100px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.85);
        color: white;
        padding: 12px 24px;
        border-radius: 24px;
        font-size: 15px;
        z-index: 99999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        animation: toastFadeInOut 2.5s ease-in-out forwards;
    `;
    
    document.body.appendChild(toast);
    
    // 2.5초 후 자동 제거
    setTimeout(() => {
        if (toast.parentNode) {
            toast.remove();
        }
    }, 2500);
}

// CSS 애니메이션 추가
if (!document.getElementById('toast-styles')) {
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
        @keyframes toastFadeInOut {
            0% { 
                opacity: 0; 
                transform: translateX(-50%) translateY(20px); 
            }
            15% { 
                opacity: 1; 
                transform: translateX(-50%) translateY(0); 
            }
            85% { 
                opacity: 1; 
                transform: translateX(-50%) translateY(0); 
            }
            100% { 
                opacity: 0; 
                transform: translateX(-50%) translateY(-20px); 
            }
        }
    `;
    document.head.appendChild(style);
}
