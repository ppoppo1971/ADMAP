/**
 * ========================================
 * DMAP - 로컬 저장소 모듈 (IndexedDB)
 * ========================================
 * - 사진/메타데이터를 로컬에 영구 저장
 * - ZIP 내보내기 (사진 + 메타데이터)
 */
(() => {
    const DB_NAME = 'dmap-local';
    const DB_VERSION = 1;
    const PROJECT_STORE = 'projects';
    const PHOTO_STORE = 'photos';

    let dbPromise = null;

    function openDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = () => {
                const db = request.result;

                if (!db.objectStoreNames.contains(PROJECT_STORE)) {
                    db.createObjectStore(PROJECT_STORE, { keyPath: 'dxfFile' });
                }

                if (!db.objectStoreNames.contains(PHOTO_STORE)) {
                    const store = db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
                    store.createIndex('dxfFile', 'dxfFile', { unique: false });
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function getDb() {
        if (!dbPromise) {
            dbPromise = openDb();
        }
        return dbPromise;
    }

    async function init() {
        await getDb();
        return true;
    }

    async function saveProject(dxfFile, data) {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PROJECT_STORE, 'readwrite');
            const store = tx.objectStore(PROJECT_STORE);
            store.put({
                dxfFile,
                texts: data.texts || [],
                lastModified: data.lastModified || new Date().toISOString()
            });
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    async function loadProject(dxfFile) {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PROJECT_STORE, 'readonly');
            const store = tx.objectStore(PROJECT_STORE);
            const request = store.get(dxfFile);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    async function savePhoto(dxfFile, photo) {
        const db = await getDb();
        const id = String(photo.id);
        const record = {
            id,
            dxfFile,
            fileName: photo.fileName || '',
            memo: photo.memo || '',
            x: photo.x,
            y: photo.y,
            width: photo.width,
            height: photo.height,
            blob: photo.blob,
            createdAt: photo.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PHOTO_STORE, 'readwrite');
            tx.objectStore(PHOTO_STORE).put(record);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    async function loadPhotos(dxfFile) {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PHOTO_STORE, 'readonly');
            const index = tx.objectStore(PHOTO_STORE).index('dxfFile');
            const request = index.getAll(dxfFile);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async function getPhotoById(id) {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PHOTO_STORE, 'readonly');
            const request = tx.objectStore(PHOTO_STORE).get(String(id));
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    async function updatePhotoMemo(id, memo) {
        const record = await getPhotoById(id);
        if (!record) return false;
        record.memo = memo || '';
        record.updatedAt = new Date().toISOString();
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PHOTO_STORE, 'readwrite');
            tx.objectStore(PHOTO_STORE).put(record);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    async function deletePhoto(id) {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PHOTO_STORE, 'readwrite');
            tx.objectStore(PHOTO_STORE).delete(String(id));
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    async function deletePhotosByDateRange(dxfFile, startMs, endMs) {
        const photos = await loadPhotos(dxfFile);
        const toDelete = photos.filter((photo) => {
            if (!photo.createdAt) {
                return false;
            }
            const createdMs = new Date(photo.createdAt).getTime();
            return createdMs >= startMs && createdMs <= endMs;
        });

        if (toDelete.length === 0) {
            return [];
        }

        const db = await getDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(PHOTO_STORE, 'readwrite');
            const store = tx.objectStore(PHOTO_STORE);
            toDelete.forEach((photo) => {
                store.delete(String(photo.id));
            });
            tx.oncomplete = () => resolve(toDelete.map(photo => photo.id));
            tx.onerror = () => reject(tx.error);
        });
    }

    function dataUrlToBlob(dataUrl) {
        const [header, base64] = dataUrl.split(',');
        const mimeMatch = header.match(/data:(.*?);base64/);
        const mimeType = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new Blob([bytes], { type: mimeType });
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function encodeUtf8(str) {
        return new TextEncoder().encode(str);
    }

    function crc32(bytes) {
        const table = crc32.table || (crc32.table = (() => {
            const t = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let k = 0; k < 8; k++) {
                    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : (c >>> 1);
                }
                t[i] = c >>> 0;
            }
            return t;
        })());

        let crc = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) {
            crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    function toDosDateTime(date) {
        const dt = date instanceof Date ? date : new Date();
        const year = Math.max(1980, dt.getFullYear());
        const month = dt.getMonth() + 1;
        const day = dt.getDate();
        const hours = dt.getHours();
        const minutes = dt.getMinutes();
        const seconds = Math.floor(dt.getSeconds() / 2);
        const dosTime = (hours << 11) | (minutes << 5) | seconds;
        const dosDate = ((year - 1980) << 9) | (month << 5) | day;
        return { dosTime, dosDate };
    }

    /**
     * ZIP 파일 생성 (메모리 최적화 버전)
     * - concatArrays 제거: Blob 생성자에 배열 직접 전달
     * - 메모리 사용량 약 30% 절감
     */
    async function createZip(entries) {
        let offset = 0;
        const fileParts = [];
        const centralParts = [];

        for (const entry of entries) {
            const nameBytes = encodeUtf8(entry.name);
            const dataBytes = new Uint8Array(await entry.blob.arrayBuffer());
            const crc = crc32(dataBytes);
            const size = dataBytes.length;
            const { dosTime, dosDate } = toDosDateTime(entry.modifiedAt);
            const flags = 0x0800; // UTF-8

            const localHeader = new ArrayBuffer(30 + nameBytes.length);
            const localView = new DataView(localHeader);
            localView.setUint32(0, 0x04034b50, true);
            localView.setUint16(4, 20, true);
            localView.setUint16(6, flags, true);
            localView.setUint16(8, 0, true);
            localView.setUint16(10, dosTime, true);
            localView.setUint16(12, dosDate, true);
            localView.setUint32(14, crc, true);
            localView.setUint32(18, size, true);
            localView.setUint32(22, size, true);
            localView.setUint16(26, nameBytes.length, true);
            localView.setUint16(28, 0, true);
            new Uint8Array(localHeader).set(nameBytes, 30);

            fileParts.push(new Uint8Array(localHeader), dataBytes);

            const centralHeader = new ArrayBuffer(46 + nameBytes.length);
            const centralView = new DataView(centralHeader);
            centralView.setUint32(0, 0x02014b50, true);
            centralView.setUint16(4, 20, true);
            centralView.setUint16(6, 20, true);
            centralView.setUint16(8, flags, true);
            centralView.setUint16(10, 0, true);
            centralView.setUint16(12, dosTime, true);
            centralView.setUint16(14, dosDate, true);
            centralView.setUint32(16, crc, true);
            centralView.setUint32(20, size, true);
            centralView.setUint32(24, size, true);
            centralView.setUint16(28, nameBytes.length, true);
            centralView.setUint16(30, 0, true);
            centralView.setUint16(32, 0, true);
            centralView.setUint16(34, 0, true);
            centralView.setUint16(36, 0, true);
            centralView.setUint32(38, 0, true);
            centralView.setUint32(42, offset, true);
            new Uint8Array(centralHeader).set(nameBytes, 46);

            centralParts.push(new Uint8Array(centralHeader));

            offset += localHeader.byteLength + size;
        }

        const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
        const centralOffset = offset;
        const fileCount = entries.length;

        const endRecord = new ArrayBuffer(22);
        const endView = new DataView(endRecord);
        endView.setUint32(0, 0x06054b50, true);
        endView.setUint16(4, 0, true);
        endView.setUint16(6, 0, true);
        endView.setUint16(8, fileCount, true);
        endView.setUint16(10, fileCount, true);
        endView.setUint32(12, centralSize, true);
        endView.setUint32(16, centralOffset, true);
        endView.setUint16(20, 0, true);

        // ✅ 개선: Blob 생성자에 배열 직접 전달 (불필요한 복사 제거)
        const allParts = [...fileParts, ...centralParts, new Uint8Array(endRecord)];
        return new Blob(allParts, { type: 'application/zip' });
    }

    function normalizeBaseName(dxfFile) {
        if (!dxfFile) return 'photo';
        return dxfFile.replace(/\.dxf$/i, '');
    }

    /**
     * 프로젝트 ZIP 내보내기 (안드로이드/iOS 호환 개선)
     * - 모바일에서 다운로드 완료 전 URL 해제 방지
     * - 용량 정보 로깅 추가
     */
    async function exportProjectZip(dxfFile) {
        const project = (await loadProject(dxfFile)) || {};
        const photos = await loadPhotos(dxfFile);
        const baseName = normalizeBaseName(dxfFile);

        // 용량 계산 및 로깅
        let totalSize = 0;
        photos.forEach(p => { if (p.blob) totalSize += p.blob.size; });
        console.log(`📦 내보내기 준비: 사진 ${photos.length}장, 총 ${(totalSize / 1024 / 1024).toFixed(2)}MB`);

        const metadata = {
            dxfFile,
            photos: photos.map((photo) => ({
                id: photo.id,
                fileName: photo.fileName,
                position: { x: photo.x, y: photo.y },
                size: { width: photo.width, height: photo.height },
                memo: photo.memo || '',
                uploaded: true
            })),
            texts: project.texts || [],
            lastModified: project.lastModified || new Date().toISOString()
        };

        const metadataBlob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
        const entries = [
            { name: `${baseName}_metadata.json`, blob: metadataBlob, modifiedAt: new Date() }
        ];

        photos.forEach((photo) => {
            if (photo.blob && photo.fileName) {
                entries.push({
                    name: photo.fileName,
                    blob: photo.blob,
                    modifiedAt: new Date(photo.updatedAt || Date.now())
                });
            }
        });

        const zipBlob = await createZip(entries);
        const zipName = `${baseName}_export.zip`;
        console.log(`📦 ZIP 생성 완료: ${zipName} (${(zipBlob.size / 1024 / 1024).toFixed(2)}MB)`);

        const url = URL.createObjectURL(zipBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = zipName;
        
        // 모바일 감지
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const isAndroid = /android/i.test(navigator.userAgent);
        const isMobile = isIOS || isAndroid;
        
        // iOS에서는 새 탭에서 열기
        if (isIOS) {
            link.target = '_blank';
        }
        
        document.body.appendChild(link);
        link.click();
        link.remove();
        
        // ✅ 개선: 모바일에서는 URL 해제 지연 (다운로드 완료 대기)
        if (isMobile) {
            // 모바일: 용량에 비례하여 대기 (최소 3초, MB당 1초 추가)
            const delaySec = Math.max(3, Math.ceil(zipBlob.size / 1024 / 1024));
            console.log(`📱 모바일 감지 - URL 해제 ${delaySec}초 후 예정`);
            setTimeout(() => {
                URL.revokeObjectURL(url);
                console.log('✅ URL 해제 완료');
            }, delaySec * 1000);
        } else {
            // 데스크톱: 1초 후 해제
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        
        return true;
    }

    async function getPhotoDataUrl(photoId) {
        const record = await getPhotoById(photoId);
        if (!record || !record.blob) return null;
        return blobToDataUrl(record.blob);
    }

    window.localStore = {
        init,
        saveProject,
        loadProject,
        savePhoto,
        loadPhotos,
        getPhotoById,
        updatePhotoMemo,
        deletePhoto,
        deletePhotosByDateRange,
        dataUrlToBlob,
        exportProjectZip,
        getPhotoDataUrl
    };
})();
