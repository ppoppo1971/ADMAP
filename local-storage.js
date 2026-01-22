/**
 * ========================================
 * DMAP - 로컬 저장소 관리 모듈 (IndexedDB)
 * ========================================
 * 
 * 용도:
 *   - Android에서 사진과 메타데이터를 IndexedDB에 저장
 *   - 실시간 저장으로 데이터 누락 방지
 *   - 다운로드 폴더로 내보내기 기능
 * 
 * 주요 기능:
 *   1. IndexedDB 초기화 및 관리
 *   2. 사진 저장/로드
 *   3. 메타데이터 저장/로드
 *   4. 다운로드 폴더로 내보내기
 * 
 * 버전: 1.0.0
 * 최종 수정: 2025-01-22
 * ========================================
 */

/**
 * IndexedDB 관리 클래스
 */
class LocalStorageManager {
    constructor() {
        this.dbName = 'dmap-local-storage';
        this.dbVersion = 1;
        this.db = null;
    }

    /**
     * IndexedDB 초기화
     */
    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                console.error('❌ IndexedDB 초기화 실패:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('✅ IndexedDB 초기화 완료');
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // 사진 저장소
                if (!db.objectStoreNames.contains('photos')) {
                    const photoStore = db.createObjectStore('photos', { keyPath: 'id' });
                    photoStore.createIndex('dxfFileName', 'dxfFileName', { unique: false });
                    photoStore.createIndex('fileName', 'fileName', { unique: false });
                }

                // 메타데이터 저장소
                if (!db.objectStoreNames.contains('metadata')) {
                    const metadataStore = db.createObjectStore('metadata', { keyPath: 'dxfFileName' });
                }

                console.log('✅ IndexedDB 스키마 생성 완료');
            };
        });
    }

    /**
     * 사진 저장
     */
    async savePhoto(photo, dxfFileName) {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['photos'], 'readwrite');
            const store = transaction.objectStore('photos');

            // Blob으로 변환하여 저장
            const photoData = {
                id: photo.id,
                dxfFileName: dxfFileName,
                x: photo.x,
                y: photo.y,
                width: photo.width,
                height: photo.height,
                memo: photo.memo || '',
                fileName: photo.fileName || null,
                imageData: photo.imageData, // Base64 문자열로 저장
                savedAt: Date.now()
            };

            const request = store.put(photoData);

            request.onsuccess = () => {
                console.log(`✅ 사진 저장 완료: ${photo.id}`);
                resolve();
            };

            request.onerror = () => {
                console.error('❌ 사진 저장 실패:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * 여러 사진 저장
     */
    async savePhotos(photos, dxfFileName) {
        if (!this.db) {
            await this.init();
        }

        const promises = photos.map(photo => this.savePhoto(photo, dxfFileName));
        await Promise.all(promises);
        console.log(`✅ ${photos.length}개 사진 저장 완료`);
    }

    /**
     * 메타데이터 저장
     */
    async saveMetadata(dxfFileName, metadata) {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readwrite');
            const store = transaction.objectStore('metadata');

            const metadataData = {
                dxfFileName: dxfFileName,
                data: metadata,
                savedAt: Date.now()
            };

            const request = store.put(metadataData);

            request.onsuccess = () => {
                console.log(`✅ 메타데이터 저장 완료: ${dxfFileName}`);
                resolve();
            };

            request.onerror = () => {
                console.error('❌ 메타데이터 저장 실패:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * 특정 DXF 파일의 모든 사진 로드
     */
    async loadPhotos(dxfFileName) {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['photos'], 'readonly');
            const store = transaction.objectStore('photos');
            const index = store.index('dxfFileName');
            const request = index.getAll(dxfFileName);

            request.onsuccess = () => {
                const photos = request.result.map(photo => ({
                    id: photo.id,
                    x: photo.x,
                    y: photo.y,
                    width: photo.width,
                    height: photo.height,
                    memo: photo.memo,
                    fileName: photo.fileName,
                    imageData: photo.imageData,
                    uploaded: false // 로컬 저장이므로 uploaded는 false
                }));

                console.log(`✅ ${photos.length}개 사진 로드 완료: ${dxfFileName}`);
                resolve(photos);
            };

            request.onerror = () => {
                console.error('❌ 사진 로드 실패:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * 메타데이터 로드
     */
    async loadMetadata(dxfFileName) {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readonly');
            const store = transaction.objectStore('metadata');
            const request = store.get(dxfFileName);

            request.onsuccess = () => {
                if (request.result) {
                    console.log(`✅ 메타데이터 로드 완료: ${dxfFileName}`);
                    resolve(request.result.data);
                } else {
                    console.log(`ℹ️ 메타데이터 없음: ${dxfFileName}`);
                    resolve(null);
                }
            };

            request.onerror = () => {
                console.error('❌ 메타데이터 로드 실패:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * 사진 삭제
     */
    async deletePhoto(photoId) {
        if (!this.db) {
            await this.init();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['photos'], 'readwrite');
            const store = transaction.objectStore('photos');
            const request = store.delete(photoId);

            request.onsuccess = () => {
                console.log(`✅ 사진 삭제 완료: ${photoId}`);
                resolve();
            };

            request.onerror = () => {
                console.error('❌ 사진 삭제 실패:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * 특정 DXF 파일의 모든 데이터 삭제
     */
    async deleteAllData(dxfFileName) {
        if (!this.db) {
            await this.init();
        }

        // 사진 삭제
        const photos = await this.loadPhotos(dxfFileName);
        const photoPromises = photos.map(photo => this.deletePhoto(photo.id));
        await Promise.all(photoPromises);

        // 메타데이터 삭제
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readwrite');
            const store = transaction.objectStore('metadata');
            const request = store.delete(dxfFileName);

            request.onsuccess = () => {
                console.log(`✅ 모든 데이터 삭제 완료: ${dxfFileName}`);
                resolve();
            };

            request.onerror = () => {
                console.error('❌ 데이터 삭제 실패:', request.error);
                reject(request.error);
            };
        });
    }

    /**
     * Base64를 Blob으로 변환
     */
    base64ToBlob(base64, mimeType = 'image/jpeg') {
        const byteCharacters = atob(base64.split(',')[1]);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
            byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        return new Blob([byteArray], { type: mimeType });
    }
}

// 전역 인스턴스 생성
window.localStorageManager = new LocalStorageManager();

