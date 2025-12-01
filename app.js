/**
 * ========================================
 * DMAP - DXF 도면 사진 편집기 (메인 앱)
 * ========================================
 * 
 * 용도:
 *   - iPhone 13 PRO에서 DXF 도면을 뷰잉하고 현장 사진/텍스트를 삽입하는 PWA
 *   - Google Drive 연동으로 실시간 자동 저장
 *   - 데스크톱 AutoCAD에서 InsertPhotos.lsp로 사진/텍스트 불러오기
 * 
 * 주요 기능:
 *   1. DXF 파일 파싱 및 SVG 렌더링
 *   2. 터치 제스처 (팬/줌/롱프레스/더블탭)
 *   3. 사진 추가/삭제/메모 작성
 *   4. 텍스트 입력/편집
 *   5. Google Drive 자동 동기화
 *   6. 메타데이터 JSON 관리
 * 
 * 최적화 (v1.1):
 *   - requestAnimationFrame으로 부드러운 렌더링
 *   - getBoundingClientRect() 캐싱 (100ms)
 *   - 중복 렌더링 방지 (pending 플래그)
 *   - 이미지 메모리 명시적 정리
 *   - debugMode로 선택적 로깅
 *   - 자동 저장 Debounce (3초 대기)
 *   - 터치 이벤트 Throttle (~60fps)
 *   - 화면 밖 요소 렌더링 스킵
 *   - 백그라운드 모드 최적화 (Visibility API)
 *   - Google Maps 이벤트 최적화 (더블 버퍼링)
 * 
 * 버전: 1.1.0
 * 최종 수정: 2025-11-27
 * ========================================
 */

// 라이브러리 로드 확인
if (typeof DxfParser === 'undefined') {
    console.error('DxfParser 라이브러리가 로드되지 않았습니다!');
    console.error('CDN 연결을 확인하세요: https://unpkg.com/dxf-parser@1.2.1/dist/dxf-parser.min.js');
}

/**
 * DXF 도면 편집기 메인 클래스
 * - 모든 UI/기능/상태 관리
 * - Google Drive 연동
 * - 터치 제스처 처리
 */
class DxfPhotoEditor {
    constructor() {
        // 화면 요소
        this.fileListScreen = document.getElementById('file-list-screen');
        this.viewerScreen = document.getElementById('viewer-screen');
        this.viewerUI = document.getElementById('viewer-ui');
        
        // 요소 확인 (디버그 모드에서만)
        
        this.canvas = document.getElementById('canvas');
        this.ctx = this.canvas.getContext('2d');
        this.svg = document.getElementById('svg');
        this.container = document.getElementById('canvas-container');
        this.photoMemoInput = document.getElementById('photo-memo-input');
        this.mapContainer = document.getElementById('map-container');
        this.mapElement = document.getElementById('map');
        
        // SVG 그룹 요소 생성
        this.svgGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.svg.appendChild(this.svgGroup);
        
        // 상태 관리
        this.dxfData = null;
        this.dxfFileName = '';
        this.photos = []; // { id, x, y, width, height, imageData, memo, fileName }
        this.viewBox = { x: 0, y: 0, width: 1000, height: 1000 };
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        
        // 터치/드래그 상태
        this.touchState = {
            isDragging: false,
            isPinching: false,
            wasDragging: false,  // 터치 종료 후 클릭 이벤트 방지용
            wasPinching: false,  // 핀치줌 종료 후 클릭 이벤트 방지용
            startX: 0,
            startY: 0,
            lastTouch: null,  // { x, y } 객체로 관리
            anchorView: null, // 드래그 시작 시 고정할 도면 좌표
            startViewBox: null,
            lastPinchDistance: 0
        };
        
        this.selectedPhotoId = null;
        this.selectedTextId = null;
        
        // 사진 그룹 관리 (동일 좌표의 여러 사진)
        this.currentPhotoGroup = []; // 현재 보고 있는 좌표의 사진 ID 배열
        this.currentPhotoIndex = 0; // 현재 보고 있는 사진의 인덱스
        
        // 롱프레스 관련
        this.longPressTimer = null;
        this.longPressDuration = 350; // 0.35초 (약간 빠르게)
        this.longPressPosition = { x: 0, y: 0 };
        this.isLongPress = false;
        this.longPressTriggered = false;

        const locationHint = (window.location?.search || '') + (window.location?.hash || '');
        this.debugMode = /debug/i.test(locationHint);
        this.driveStateInitialized = false;
        this.hasPromptedLocalDriveLogin = false;
        this.localDriveRequestInProgress = false;
        this.pendingLocalDriveSync = false;
        this.localSourceFile = null;
        
        // 더블탭 관련
        this.lastTapTime = 0;
        this.lastTapPosition = { x: 0, y: 0 };
        this.doubleTapDelay = 300; // 300ms 이내 두 번 탭
        this.doubleTapDistance = 50; // 50px 이내 같은 위치
        this.tapMoveThreshold = 15; // 탭으로 인정할 최대 이동 거리 (px)
        this.lastTouchTime = 0;
        this.singleTapTimeout = null;
        this.pendingTapAction = null;
        
        // 텍스트 관련
        this.texts = []; // { id, x, y, text, fontSize }
        this.metadataDirty = false;
        
        // 이미지 용량 설정 (기본값: 500KB)
        // '500KB', '1MB', 'original' 중 하나
        this.imageSizeSetting = localStorage.getItem('dmap:imageSize') || '500KB';
        
        // 지도 관련
        this.map = null; // Google Maps 객체
        this.currentMapType = null; // 현재 지도 타입: 'google', 'vworld', null
        this.mapInitialized = false;
        this.dxfBounds = null; // DXF 도면의 EPSG:5186 좌표 경계 { minX, minY, maxX, maxY }
        this.dxfBoundsWGS84 = null; // 변환된 WGS84 좌표 경계 { minLat, minLng, maxLat, maxLng }
        this.mapBoundsListener = null; // 지도 bounds 변경 리스너
        this.boundsChangeTimeout = null; // bounds_changed throttle용
        this.lastSyncedViewBoxSize = null; // 지도와 동기화된 마지막 뷰박스 크기
        this.isMapMode = false; // 지도 모드 여부
        this.syncingFromMap = false; // 지도에서 도면으로 동기화 중인지 (무한 루프 방지)
        this.syncingFromViewBox = false; // 도면에서 지도로 동기화 중인지 (무한 루프 방지)
        this.mapOverlay = null; // 지도 좌표→픽셀 변환용 OverlayView
        this.currentLocationData = null; // 현재 위치 정보 캐시
        this.currentLocationMarker = null; // 현재 위치 마커
        this.currentLocationInfoWindow = null; // 현재 위치 정보창
        
        // 렌더링 최적화
        this.redrawPending = false;
        this.updatePending = false;
        
        // getBoundingClientRect() 캐싱 (성능 최적화)
        this.cachedRect = null;
        this.rectCacheTime = 0;
        this.rectCacheDuration = 100; // 100ms 동안 캐시 유지
        
        // 드래그 감도 설정 (1.0 = 손가락 이동과 동일)
        this.panSensitivity = 1.0;
        
        // 자동 저장 Debounce 관련
        this.autoSaveTimeout = null;
        this.autoSaveDelay = 3000; // 3초 대기
        this.isAutoSaving = false;
        this.autoSavePending = false; // 저장 완료 후 재실행 플래그
        
        // ViewBox 업데이트 Throttle (60fps = 16ms)
        this.updateViewBoxThrottled = this.throttle(() => {
            this.updateViewBox();
        }, 16); // ~60fps
        
        // 백그라운드 모드 최적화
        this.pauseAutoSave = false;
        this.setupVisibilityListener();

        // 성능 분석용 타임 로그 초기화
        this._lastLogTime = performance.now();
        
        this.init();
    }

    debugLog(...args) {
        if (!this.debugMode) {
            return;
        }
        console.log(...args);
    }

    /**
     * 성능 분석용 타임 로그
     * - 주요 구간 사이 경과 시간을 console에 출력
     */
    logTime(label) {
        try {
            const now = performance.now();
            if (typeof this._lastLogTime !== 'number') {
                this._lastLogTime = now;
            }
            const diff = now - this._lastLogTime;
            console.log(`⏱ [${label}] +${diff.toFixed(1)}ms (t=${now.toFixed(1)}ms)`);
            this._lastLogTime = now;
        } catch (e) {
            // performance.now()가 없는 환경에서도 앱이 죽지 않도록 방어
            console.log(`⏱ [${label}]`);
        }
    }
    
    /**
     * Throttle 유틸리티 - 함수 호출을 일정 간격으로 제한
     * 성능 최적화: 터치 이벤트 등 빈번한 호출을 제한하여 CPU 사용량 감소
     * 
     * @param {Function} func - 실행할 함수
     * @param {number} limit - 제한 시간 (ms, 예: 16ms = ~60fps)
     * @returns {Function} Throttle된 함수
     * 
     * @example
     * const throttledUpdate = this.throttle(() => this.updateViewBox(), 16);
     * // 16ms 이내에 여러 번 호출해도 한 번만 실행됨
     */
    throttle(func, limit) {
        let inThrottle;
        let lastResult;
        return function(...args) {
            if (!inThrottle) {
                lastResult = func.apply(this, args);
                inThrottle = true;
                setTimeout(() => {
                    inThrottle = false;
                }, limit);
            }
            return lastResult;
        };
    }
    
    getEntityColor(entity) {
        let color = null;
        
        // 1. ByLayer 확인 (colorIndex === 256 또는 colorIndex가 없는 경우)
        if (entity.colorIndex === 256 || entity.colorIndex === undefined) {
            // 레이어 색상 찾기
            if (entity.layer && this.dxfData.tables) {
                const layersObj = this.dxfData.tables.layers || this.dxfData.tables.layer;
                
                if (layersObj) {
                    let layer = null;
                    
                    // A. 직접 객체 접근 (예: layers["L_가드펜스"])
                    if (!Array.isArray(layersObj) && typeof layersObj === 'object') {
                        layer = layersObj[entity.layer];
                    }
                    
                    // B. layers.layers 객체 (예: layers.layers["L_가드펜스"])
                    if (!layer && layersObj.layers) {
                        if (Array.isArray(layersObj.layers)) {
                            layer = layersObj.layers.find(l => l.name === entity.layer);
                        } else if (typeof layersObj.layers === 'object') {
                            layer = layersObj.layers[entity.layer];
                        }
                    }
                    
                    // C. 직접 배열 (예: layers[0].name)
                    if (!layer && Array.isArray(layersObj)) {
                        layer = layersObj.find(l => l.name === entity.layer);
                    }
                    
                    // 레이어에서 색상 추출
                    if (layer) {
                        // colorIndex 우선
                        if (layer.colorIndex !== undefined && layer.colorIndex !== null) {
                            color = this.autocadColorIndexToHex(layer.colorIndex);
                        }
                        // color 대체
                        else if (layer.color !== undefined && layer.color !== null) {
                            if (typeof layer.color === 'string') {
                                color = layer.color;
                            } else if (typeof layer.color === 'number') {
                                color = '#' + layer.color.toString(16).padStart(6, '0').toUpperCase();
                            }
                        }
                    }
                }
            }
        }
        // 2. 엔티티 자체의 colorIndex 확인 (ByLayer가 아닌 경우)
        else if (entity.colorIndex !== undefined && entity.colorIndex >= 0 && entity.colorIndex < 256) {
            color = this.autocadColorIndexToHex(entity.colorIndex);
        }
        
        // 3. entity.color 확인 (dxf-parser가 이미 변환한 경우)
        if (!color && entity.color !== undefined && entity.color !== null) {
            if (typeof entity.color === 'string') {
                color = entity.color;
            } else if (typeof entity.color === 'number') {
                color = '#' + entity.color.toString(16).padStart(6, '0').toUpperCase();
            }
        }
        
        // 4. 기본값: 검은색
        if (!color) {
            color = '#000000';
        }
        
        // 5. 흰색이면 검은색으로 변경 (배경과 구분)
        if (color.toUpperCase() === '#FFFFFF' || color.toUpperCase() === '#FFF') {
            color = '#000000';
        }
        
        // 디버깅 (처음 20개)
        if (this.debugMode && this.colorDebugCount < 20) {
            this.debugLog(`🎨 [${this.colorDebugCount}] ${entity.type} → ${color} (출처: ${source})`);
            this.debugLog(`   colorIndex=${entity.colorIndex}, layer="${entity.layer}"`);
            this.colorDebugCount++;
        }
        
        return color;
    }
    
    autocadColorIndexToHex(colorIndex) {
        // AutoCAD 표준 색상 팔레트 (256색)
        // dxf-parser 라이브러리의 색상 팔레트와 동일
        const autocadColors = [
            0x000000, 0xFF0000, 0xFFFF00, 0x00FF00, 0x00FFFF, 0x0000FF, 0xFF00FF, 0xFFFFFF,
            0x414141, 0x808080, 0xFF0000, 0xFFAAAA, 0xBD0000, 0xBD7E7E, 0x810000, 0x815656,
            0x680000, 0x684545, 0x4F0000, 0x4F3535, 0xFF3F00, 0xFFBFAA, 0xBD2E00, 0xBD8D7E,
            0x811F00, 0x816056, 0x681900, 0x684E45, 0x4F1300, 0x4F3B35, 0xFF7F00, 0xFFD4AA,
            0xBD5E00, 0xBD9D7E, 0x814000, 0x816B56, 0x683400, 0x685645, 0x4F2700, 0x4F4235,
            0xFFBF00, 0xFFEAAA, 0xBD8D00, 0xBDAD7E, 0x816000, 0x817656, 0x684E00, 0x685F45,
            0x4F3B00, 0x4F4935, 0xFFFF00, 0xFFFFAA, 0xBDBD00, 0xBDBD7E, 0x818100, 0x818156,
            0x686800, 0x686845, 0x4F4F00, 0x4F4F35, 0xBFFF00, 0xEAFFAA, 0x8DBD00, 0xADBD7E,
            0x608100, 0x768156, 0x4E6800, 0x5F6845, 0x3B4F00, 0x494F35, 0x7FFF00, 0xD4FFAA,
            0x5EBD00, 0x9DBD7E, 0x408100, 0x6B8156, 0x346800, 0x566845, 0x274F00, 0x424F35,
            0x3FFF00, 0xBFFFAA, 0x2EBD00, 0x8DBD7E, 0x1F8100, 0x608156, 0x196800, 0x4E6845,
            0x134F00, 0x3B4F35, 0x00FF00, 0xAAFFAA, 0x00BD00, 0x7EBD7E, 0x008100, 0x568156,
            0x006800, 0x456845, 0x004F00, 0x354F35, 0x00FF3F, 0xAAFFBF, 0x00BD2E, 0x7EBD8D,
            0x00811F, 0x568160, 0x006819, 0x45684E, 0x004F13, 0x354F3B, 0x00FF7F, 0xAAFFD4,
            0x00BD5E, 0x7EBD9D, 0x008140, 0x56816B, 0x006834, 0x456856, 0x004F27, 0x354F42,
            0x00FFBF, 0xAAFFEA, 0x00BD8D, 0x7EBDAD, 0x008160, 0x568176, 0x00684E, 0x45685F,
            0x004F3B, 0x354F49, 0x00FFFF, 0xAAFFFF, 0x00BDBD, 0x7EBDBD, 0x008181, 0x568181,
            0x006868, 0x456868, 0x004F4F, 0x354F4F, 0x00BFFF, 0xAAEAFF, 0x008DBD, 0x7EADBD,
            0x006081, 0x567681, 0x004E68, 0x455F68, 0x003B4F, 0x35494F, 0x007FFF, 0xAAD4FF,
            0x005EBD, 0x7E9DBD, 0x004081, 0x566B81, 0x003468, 0x455668, 0x00274F, 0x35424F,
            0x003FFF, 0xAABFFF, 0x002EBD, 0x7E8DBD, 0x001F81, 0x566081, 0x001968, 0x454E68,
            0x00134F, 0x353B4F, 0x0000FF, 0xAAAAFF, 0x0000BD, 0x7E7EBD, 0x000081, 0x565681,
            0x000068, 0x454568, 0x00004F, 0x35354F, 0x3F00FF, 0xBFAAFF, 0x2E00BD, 0x8D7EBD,
            0x1F0081, 0x605681, 0x190068, 0x4E4568, 0x13004F, 0x3B354F, 0x7F00FF, 0xD4AAFF,
            0x5E00BD, 0x9D7EBD, 0x400081, 0x6B5681, 0x340068, 0x564568, 0x27004F, 0x42354F,
            0xBF00FF, 0xEAAAFF, 0x8D00BD, 0xAD7EBD, 0x600081, 0x765681, 0x4E0068, 0x5F4568,
            0x3B004F, 0x49354F, 0xFF00FF, 0xFFAAFF, 0xBD00BD, 0xBD7EBD, 0x810081, 0x815681,
            0x680068, 0x684568, 0x4F004F, 0x4F354F, 0xFF00BF, 0xFFAAEA, 0xBD008D, 0xBD7EAD,
            0x810060, 0x815676, 0x68004E, 0x68455F, 0x4F003B, 0x4F3549, 0xFF007F, 0xFFAAD4,
            0xBD005E, 0xBD7E9D, 0x810040, 0x81566B, 0x680034, 0x684556, 0x4F0027, 0x4F3542,
            0xFF003F, 0xFFAABF, 0xBD002E, 0xBD7E8D, 0x81001F, 0x815660, 0x680019, 0x68454E,
            0x4F0013, 0x4F353B, 0x333333, 0x505050, 0x696969, 0x828282, 0xBEBEBE, 0xFFFFFF
        ];
        
        // 유효성 검사
        if (typeof colorIndex !== 'number' || colorIndex < 0 || colorIndex >= 256) {
            console.warn(`⚠️ 잘못된 colorIndex: ${colorIndex}, 기본값(검은색) 반환`);
            return '#000000';
        }
        
        // 배열 길이 확인 (디버깅용, 첫 실행 시에만)
        if (!this._colorArrayChecked) {
            console.log(`✅ AutoCAD 색상 팔레트 크기: ${autocadColors.length}개`);
            this._colorArrayChecked = true;
        }
        
        const rgb = autocadColors[colorIndex];
        const hex = '#' + rgb.toString(16).padStart(6, '0').toUpperCase();
        
        return hex;
    }
    
    hslToHex(h, s, l) {
        l /= 100;
        const a = s * Math.min(l, 1 - l) / 100;
        const f = n => {
            const k = (n + h / 30) % 12;
            const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
            return Math.round(255 * color).toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    }
    
    /**
     * getBoundingClientRect() 캐싱 (성능 최적화)
     * 레이아웃 재계산 강제를 최소화
     */
    getCachedRect() {
        const now = Date.now();
        
        // 캐시가 유효하면 재사용
        if (this.cachedRect && (now - this.rectCacheTime) < this.rectCacheDuration) {
            return this.cachedRect;
        }
        
        // 캐시 갱신
        this.cachedRect = this.svg.getBoundingClientRect();
        this.rectCacheTime = now;
        
        return this.cachedRect;
    }

    viewToCanvasCoords(x, y) {
        if (!this.svg) {
            return { x, y };
        }
        
        const rect = this.getCachedRect();
        
        try {
            if (this.svg.createSVGPoint && typeof this.svg.getScreenCTM === 'function') {
                const point = this.svg.createSVGPoint();
                point.x = x;
                point.y = y;
                
                const ctm = this.svg.getScreenCTM();
                if (ctm && typeof ctm === 'object') {
                    const screenPoint = point.matrixTransform(ctm);
                    if (rect) {
                        return {
                            x: screenPoint.x - rect.left,
                            y: screenPoint.y - rect.top
                        };
                    }
                    return { x: screenPoint.x, y: screenPoint.y };
                }
            }
        } catch (error) {
            console.warn('viewToCanvasCoords 변환 실패, 폴백 사용:', error);
        }

        if (!rect) {
            return { x: 0, y: 0 };
        }

        const normX = ((x - this.viewBox.x) / this.viewBox.width) * rect.width;
        const normY = ((y - this.viewBox.y) / this.viewBox.height) * rect.height;
        return { x: normX, y: normY };
    }

    getDxfBaseName() {
        const driveName = window.currentDriveFile?.name;
        const base = driveName || (this.dxfFileName ? `${this.dxfFileName}.dxf` : 'photo');
        return base.replace(/\.dxf$/i, '');
    }
    
    /**
     * 현재 제스처가 탭에 해당하는지 여부
     */
    isTapGesture(touch) {
        if (!touch) return false;
        
        if (typeof this.touchState.startX !== 'number' || typeof this.touchState.startY !== 'number') {
            return true;
        }
        
        const moveDistance = Math.sqrt(
            Math.pow(touch.clientX - this.touchState.startX, 2) +
            Math.pow(touch.clientY - this.touchState.startY, 2)
        );
        
        return moveDistance < this.tapMoveThreshold;
    }

    queueSingleTapAction(action) {
        if (typeof action !== 'function') return;
        this.clearPendingSingleTap();
        this.pendingTapAction = action;
        this.singleTapTimeout = setTimeout(() => {
            if (this.pendingTapAction) {
                try {
                    this.pendingTapAction();
                } catch (error) {
                    console.error('❌ 단일 탭 액션 실행 오류:', error);
                }
            }
            this.clearPendingSingleTap();
        }, this.doubleTapDelay);
    }

    clearPendingSingleTap() {
        if (this.singleTapTimeout) {
            clearTimeout(this.singleTapTimeout);
            this.singleTapTimeout = null;
        }
        this.pendingTapAction = null;
    }
    
    /**
     * 더블탭 감지 및 줌 처리
     * ⚠️ 핀치줌이나 드래그 중에는 더블탭 감지 비활성화
     */
    handleDoubleTap(clientX, clientY) {
        // 핀치줌이나 드래그 중이면 더블탭 감지 비활성화
        if (this.touchState.isPinching || this.touchState.wasPinching || 
            this.touchState.isDragging || this.touchState.wasDragging) {
            // 타이머 초기화하여 오인식 방지
            this.lastTapTime = 0;
            this.lastTapPosition = { x: 0, y: 0 };
            return false;
        }
        
        const now = Date.now();
        const timeDiff = now - this.lastTapTime;
        
        // 거리 계산
        const distance = Math.sqrt(
            Math.pow(clientX - this.lastTapPosition.x, 2) + 
            Math.pow(clientY - this.lastTapPosition.y, 2)
        );
        
        const isDoubleTap = timeDiff < this.doubleTapDelay && distance < this.doubleTapDistance;
        
        if (isDoubleTap) {
            console.log('🎯🎯 더블탭 감지! 줌 실행...');
            this.clearPendingSingleTap();
            
            // 더블탭한 위치를 ViewBox 좌표로 변환 (screenToViewBox 사용으로 정확도 향상)
            const tapCoords = this.screenToViewBox(clientX, clientY);
            
            // 더블탭한 위치가 화면 중앙에 오도록 하고, 그 위치를 기준으로 5배 확대
            this.zoomToPoint(tapCoords.x, tapCoords.y, 5.0);
            
            // 더블탭 정보 초기화 (연속 더블탭 방지)
            this.lastTapTime = 0;
            this.lastTapPosition = { x: 0, y: 0 };
            
            return true;
        }
        
        // 첫 번째 탭 기록
        this.lastTapTime = now;
        this.lastTapPosition = { x: clientX, y: clientY };
        return false;
    }
    
    /**
     * 특정 점으로 줌 (애니메이션)
     * @param {number} targetX - ViewBox 좌표 X
     * @param {number} targetY - ViewBox 좌표 Y
     * @param {number} zoomFactor - 확대 배율 (2.5 = 2.5배 확대, 기본값)
     */
    zoomToPoint(targetX, targetY, zoomFactor) {
        this.debugLog(`🔍 zoomToPoint 시작:`);
        this.debugLog(`   타겟: (${targetX.toFixed(1)}, ${targetY.toFixed(1)})`);
        this.debugLog(`   현재 ViewBox: x=${this.viewBox.x.toFixed(1)}, y=${this.viewBox.y.toFixed(1)}, w=${this.viewBox.width.toFixed(1)}, h=${this.viewBox.height.toFixed(1)}`);
        
        // 새로운 ViewBox 크기
        let newWidth = this.viewBox.width / zoomFactor;
        let newHeight = this.viewBox.height / zoomFactor;
        
        this.debugLog(`   새 크기: w=${newWidth.toFixed(1)}, h=${newHeight.toFixed(1)} (${zoomFactor}배)`);
        
        // 최소/최대 크기 제한
        const minSize = (this.originalViewBox?.width || 1000) * 0.01;
        const maxSize = (this.originalViewBox?.width || 1000) * 10;
        
        // 마지막 단계에서 한계를 "건너뛰지" 않도록
        // 범위를 벗어나려 할 때는 취소 대신 경계값으로 강제 클램프
        if (newWidth < minSize) {
            const ratio = minSize / newWidth;
            newWidth = minSize;
            newHeight *= ratio;
        } else if (newWidth > maxSize) {
            const ratio = maxSize / newWidth;
            newWidth = maxSize;
            newHeight *= ratio;
        }
        
        // 타겟 포인트가 화면 중심에 오도록 ViewBox 조정
        const newX = targetX - newWidth / 2;
        const newY = targetY - newHeight / 2;
        
        this.debugLog(`   새 ViewBox: x=${newX.toFixed(1)}, y=${newY.toFixed(1)}`);
        this.debugLog(`   → 화면 중심 = (${(newX + newWidth / 2).toFixed(1)}, ${(newY + newHeight / 2).toFixed(1)})`);
        
        this.viewBox = {
            x: newX,
            y: newY,
            width: newWidth,
            height: newHeight
        };
        
        // ViewBox 업데이트 (비동기로 처리하여 렌더링 블로킹 방지)
        requestAnimationFrame(() => {
            this.updateViewBox();
            this.debugLog(`✅ 줌 완료!`);
        });
    }
    
    init() {
        this.setupCanvas();
        this.setupEventListeners();
        this.drawWelcomeScreen();
    }
    
    /**
     * Visibility API를 활용한 백그라운드 모드 최적화
     * 성능 최적화: 페이지가 백그라운드에 있을 때 자동 저장 등을 일시 정지하여 배터리 절약
     * 
     * ⚠️ 중요: 저장이 진행 중일 때는 백그라운드 전환과 관계없이 저장이 완료되어야 함
     * - 사용자 작업(사진 촬영, 텍스트 입력) 내용이 손실되지 않도록 보장
     * 
     * 동작:
     * - 백그라운드 진입: 자동 저장 일시 정지 (단, 저장 진행 중이 아닐 때만)
     * - 포그라운드 복귀: 자동 저장 재개
     * - 저장 진행 중: 백그라운드 전환과 관계없이 저장 계속 진행
     */
    setupVisibilityListener() {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // 백그라운드 진입
                // ⚠️ 중요: 저장이 진행 중이 아닐 때만 일시 정지
                // 저장이 진행 중이면 백그라운드에서도 계속 진행되어야 함
                if (!this.isAutoSaving) {
                    this.pauseAutoSave = true;
                    console.log('⏸️ 백그라운드 모드 진입 - 자동 저장 일시 정지');
                } else {
                    // 저장 진행 중이면 일시 정지하지 않음
                    console.log('⏸️ 백그라운드 모드 진입 (저장 진행 중 - 저장 계속 진행)');
                }
            } else {
                // 포그라운드 복귀: 자동 저장 재개
                this.pauseAutoSave = false;
                console.log('▶️ 포그라운드 복귀 - 자동 저장 재개');
                
                // 포그라운드 복귀 시 저장되지 않은 데이터가 있으면 자동 저장
                const hasUnsavedData = this.photos.some(p => !p.uploaded) || this.metadataDirty;
                if (hasUnsavedData && !this.isAutoSaving) {
                    console.log('💾 저장되지 않은 데이터 감지 - 자동 저장 시작');
                    this.autoSave(true).catch(error => {
                        console.error('❌ 포그라운드 복귀 시 자동 저장 오류:', error);
                    });
                }
            }
        });
    }
    
    setupCanvas() {
        const updateCanvasSize = () => {
            const rect = this.container.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                this.canvas.width = rect.width;
                this.canvas.height = rect.height;
                
                // dxfData가 있을 때만 redraw
                if (this.dxfData) {
                    this.redraw();
                }
            }
        };
        
        // 초기 크기 설정 시도
        updateCanvasSize();
        
        // 윈도우 크기 변경 시 재계산
        window.addEventListener('resize', () => {
            this.cachedRect = null;
            updateCanvasSize();
        });
    }
    
    setupEventListeners() {
        // Google Drive 로그인 버튼
        document.getElementById('login-btn').addEventListener('click', async () => {
            await this.handleLogin();
        });
        
        // 로컬 저장소 버튼 (로컬 파일 선택)
        document.getElementById('local-file-input').addEventListener('change', async (e) => {
            if (e.target.files[0]) {
                this.showViewer();  // 먼저 화면 전환
                await this.loadDxfFile(e.target.files[0]);
                e.target.value = ''; // 초기화
            }
        });
        
        // 햄버거 메뉴 토글
        const hamburgerBtn = document.getElementById('hamburger-btn');
        
        hamburgerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleSlideMenu();
        });
        
        // 햄버거 버튼 터치 이벤트에서 롱프레스 방지
        hamburgerBtn.addEventListener('touchstart', (e) => {
            e.stopPropagation();
        }, { passive: false });
        hamburgerBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });
        
        // 메뉴 오버레이 클릭 시 메뉴 닫기
        document.getElementById('menu-overlay').addEventListener('click', () => {
            this.closeSlideMenu();
        });
        
        // 슬라이딩 메뉴 - 목록으로 돌아가기
        const menuBackBtn = document.getElementById('menu-back-to-list');
        const menuFitViewBtn = document.getElementById('menu-fit-view');
        const menuCheckMissingBtn = document.getElementById('menu-check-missing');
        const menuImageSizeBtn = document.getElementById('menu-image-size');
        const menuMapGoogleBtn = document.getElementById('menu-map-google');
        const menuMapVworldBtn = document.getElementById('menu-map-vworld');
        const currentLocationBtn = document.getElementById('current-location-btn');
        const menuConsoleBtn = document.getElementById('menu-console');
        
        console.log('🔍 슬라이딩 메뉴 버튼 확인:', {
            menuBackBtn: !!menuBackBtn,
            menuFitViewBtn: !!menuFitViewBtn,
            menuCheckMissingBtn: !!menuCheckMissingBtn,
            menuImageSizeBtn: !!menuImageSizeBtn,
            menuConsoleBtn: !!menuConsoleBtn
        });
        
        if (menuBackBtn) {
            menuBackBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                this.closeSlideMenu();
                
                // GitHub에서 프로그램을 다시 로드하기 위해 페이지 새로고침
                // 캐시를 무시하고 최신 버전 로드
                await this.reloadFromGitHub();
            });
        }
        
        if (menuFitViewBtn) {
            menuFitViewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeSlideMenu();
                this.fitDxfToView();
                this.redraw();
            });
        }
        
        if (menuCheckMissingBtn) {
            menuCheckMissingBtn.addEventListener('click', (e) => {
                console.log('✅ 사진누락확인 버튼 클릭됨!');
                e.stopPropagation();
                this.closeSlideMenu();
                this.checkMissingPhotos();
            });
        } else {
            console.error('❌ menu-check-missing 버튼을 찾을 수 없습니다!');
        }
        
        if (menuImageSizeBtn) {
            menuImageSizeBtn.addEventListener('click', (e) => {
                console.log('✅ 용량조정 버튼 클릭됨!');
                e.stopPropagation();
                this.closeSlideMenu();
                this.showImageSizeModal();
            });
        } else {
            console.error('❌ menu-image-size 버튼을 찾을 수 없습니다!');
        }
        
        if (menuMapGoogleBtn) {
            menuMapGoogleBtn.addEventListener('click', (e) => {
                console.log('✅ 구글맵 버튼 클릭됨!');
                e.stopPropagation();
                this.closeSlideMenu();
                // 토글 기능: 현재 구글맵이 켜져있으면 끄고, 아니면 켜기
                if (this.currentMapType === 'google') {
                    this.hideMap();
                } else {
                    this.showMap('google');
                }
            });
        } else {
            console.error('❌ menu-map-google 버튼을 찾을 수 없습니다!');
        }
        
        if (menuMapVworldBtn) {
            menuMapVworldBtn.addEventListener('click', (e) => {
                console.log('✅ 브이월드 버튼 클릭됨!');
                e.stopPropagation();
                this.closeSlideMenu();
                // 토글 기능: 현재 브이월드가 켜져있으면 끄고, 아니면 켜기
                if (this.currentMapType === 'vworld') {
                    this.hideMap();
                } else {
                    this.showMap('vworld');
                }
            });
        } else {
            console.error('❌ menu-map-vworld 버튼을 찾을 수 없습니다!');
        }
        
        if (currentLocationBtn) {
            currentLocationBtn.addEventListener('click', (e) => {
                console.log('✅ 현재위치 버튼 클릭됨!');
                e.stopPropagation();
                this.showCurrentLocation();
            });
        } else {
            console.error('❌ current-location-btn 버튼을 찾을 수 없습니다!');
        }
        
        if (menuConsoleBtn) {
            menuConsoleBtn.addEventListener('click', (e) => {
                console.log('✅ 콘솔 버튼 클릭됨!');
                e.stopPropagation();
                this.closeSlideMenu();
                
                // vConsole 토글 - 스위치 버튼을 클릭하는 방식으로 토글
                const vcSwitch = document.querySelector('.vc-switch');
                
                if (vcSwitch) {
                    // vConsole의 스위치 버튼을 클릭하여 토글
                    vcSwitch.click();
                    console.log('📱 vConsole 토글됨 (스위치 버튼 클릭)');
                } else {
                    // 스위치 버튼이 없으면 직접 API 사용
                    const vc = window.vConsole || (typeof vConsole !== 'undefined' ? vConsole : null);
                    
                    if (vc) {
                        // vConsole 패널이 열려있는지 확인
                        const vcPanel = document.querySelector('.vc-panel');
                        const isOpen = vcPanel && 
                                       vcPanel.offsetParent !== null && 
                                       vcPanel.style.display !== 'none';
                        
                        if (isOpen) {
                            vc.hide();
                            console.log('📱 vConsole 닫힘 (API)');
                        } else {
                            vc.show();
                            console.log('📱 vConsole 열림 (API)');
                        }
                    } else {
                        console.warn('⚠️ vConsole이 초기화되지 않았습니다');
                        console.log('window.vConsole:', typeof window.vConsole, window.vConsole);
                    }
                }
            });
        } else {
            console.error('❌ menu-console 버튼을 찾을 수 없습니다!');
        }
        
        // 메뉴 아이템들 터치 이벤트에서 롱프레스 방지
        [menuBackBtn, menuFitViewBtn, menuCheckMissingBtn, menuImageSizeBtn, menuMapGoogleBtn, menuMapVworldBtn, menuConsoleBtn].forEach(btn => {
            if (btn) {
                btn.addEventListener('touchstart', (e) => {
                    e.stopPropagation();
                }, { passive: false });
                btn.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                });
            }
        });
        
        // 사진 추가 버튼 제거 (롱프레스로만 추가)
        
        // 내보내기 버튼 제거됨 (Google Drive 자동 저장 사용)
        
        // SVG 드래그 (팬) - SVG에서 이벤트 받기
        this.svg.addEventListener('mousedown', this.onMouseDown.bind(this));
        this.svg.addEventListener('mousemove', this.onMouseMove.bind(this));
        this.svg.addEventListener('mouseup', this.onMouseUp.bind(this));
        
        // 터치 이벤트 (모바일) - SVG에서 (passive: false로 preventDefault 가능)
        this.svg.addEventListener('touchstart', this.onTouchStart.bind(this), { passive: false });
        this.svg.addEventListener('touchmove', this.onTouchMove.bind(this), { passive: false });
        this.svg.addEventListener('touchend', this.onTouchEnd.bind(this), { passive: false });
        
        // 지도 컨테이너에서도 동일한 이벤트 처리 (지도 활성화 시 롱프레스/탭 유지)
        if (this.mapContainer) {
            this.mapContainer.addEventListener('touchstart', (e) => {
                if (!this.isMapMode) return;
                this.onTouchStart(e);
            }, { passive: false });
            this.mapContainer.addEventListener('touchmove', (e) => {
                if (!this.isMapMode) return;
                this.onTouchMove(e);
            }, { passive: false });
            this.mapContainer.addEventListener('touchend', (e) => {
                if (!this.isMapMode) return;
                this.onTouchEnd(e);
            }, { passive: false });
            
            this.mapContainer.addEventListener('mousedown', (e) => {
                if (!this.isMapMode) return;
                this.onMouseDown(e);
            });
            this.mapContainer.addEventListener('mousemove', (e) => {
                if (!this.isMapMode) return;
                this.onMouseMove(e);
            });
            this.mapContainer.addEventListener('mouseup', (e) => {
                if (!this.isMapMode) return;
                this.onMouseUp(e);
            });
            
            this.mapContainer.addEventListener('contextmenu', (e) => {
                if (this.isMapMode) {
                    e.preventDefault();
                }
            });
        }
        
        // 사진 클릭은 SVG 클릭 이벤트에서 처리 (Canvas는 pointer-events: none 유지)
        this.svg.addEventListener('click', this.onCanvasClick.bind(this));
        
        // 줌 버튼 (좌측 하단 고정)
        const zoomInBtn = document.getElementById('zoom-in');
        const zoomOutBtn = document.getElementById('zoom-out');
        
        zoomInBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // 확대 단계를 2.5배로 증가: 1.2 * 2.5 = 3.0
            this.zoom(3.0);
        });
        
        zoomOutBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // 축소 단계를 2.5배로 증가: 0.8 / 2.5 = 0.32 (또는 1/3.0 = 0.333)
            this.zoom(1/3.0);
        });
        
        // 줌 버튼 터치 이벤트에서 롱프레스 방지
        [zoomInBtn, zoomOutBtn].forEach(btn => {
            btn.addEventListener('touchstart', (e) => {
                e.stopPropagation();
            }, { passive: false });
            btn.addEventListener('mousedown', (e) => {
                e.stopPropagation();
            });
        });
        
        // 전체보기는 슬라이딩 메뉴에서 처리됨
        
        // 메모 모달
        const closeMemoBtn = document.getElementById('close-memo');
        if (closeMemoBtn) {
            closeMemoBtn.addEventListener('click', () => {
                this.closeMemoModal();
            });
        } else {
            console.warn('⚠️ close-memo 버튼을 찾을 수 없습니다');
        }
        
        const saveMemoBtn = document.getElementById('save-memo');
        if (saveMemoBtn) {
            saveMemoBtn.addEventListener('click', () => {
                this.saveMemo();
            });
        } else {
            console.warn('⚠️ save-memo 버튼을 찾을 수 없습니다');
        }
        
        const deletePhotoBtn = document.getElementById('delete-photo-btn');
        if (deletePhotoBtn) {
            deletePhotoBtn.addEventListener('click', () => {
                this.deletePhoto();
            });
        } else {
            console.warn('⚠️ delete-photo-btn 버튼을 찾을 수 없습니다');
        }
        
        // 롱프레스 이벤트 (SVG에 추가)
        this.setupLongPressEvents();
        
        // ⭐ 컨텍스트 메뉴 버튼 이벤트는 showContextMenu에서 등록됨
        // (메뉴가 표시될 때마다 이벤트 리스너를 새로 등록)
        
        // 카메라/갤러리 파일 입력
        document.getElementById('camera-input').addEventListener('change', async (e) => {
            try {
                const file = e.target.files[0];
                this.debugLog('📸 카메라 입력:', file?.name, file?.size, 'bytes');
                
                if (!file) {
                    this.showToast('⚠️ 파일이 선택되지 않았습니다');
                    return;
                }
                
                if (!file.type.startsWith('image/')) {
                    console.error('❌ 이미지 파일이 아닙니다:', file.type);
                    this.showToast('⚠️ 이미지 파일만 선택할 수 있습니다');
                    return;
                }
                
                // pendingPhotoLocation이 있으면 사용 (동일 좌표에 추가)
                // 없으면 longPressPosition 사용 (일반 추가)
                const position = this.pendingPhotoLocation 
                    ? { x: this.pendingPhotoLocation.x, y: this.pendingPhotoLocation.y }
                    : { x: this.longPressPosition.x, y: this.longPressPosition.y };

                this.showToast('📸 사진 처리 중...');
                await this.addPhotoAt(file, position, this.pendingPhotoLocation);
                
                // pendingPhotoLocation 초기화
                this.pendingPhotoLocation = null;
                
            } catch (error) {
                console.error('❌ 카메라 입력 처리 오류:', error);
                this.showToast(`⚠️ 사진 추가 실패: ${error.message}`);
            } finally {
                e.target.value = ''; // 초기화
            }
        });
        
        document.getElementById('gallery-input').addEventListener('change', async (e) => {
            try {
                const file = e.target.files[0];
                this.debugLog('🖼️ 갤러리 입력:', file?.name, file?.size, 'bytes');
                
                if (!file) {
                    this.showToast('⚠️ 파일이 선택되지 않았습니다');
                    return;
                }
                
                if (!file.type.startsWith('image/')) {
                    console.error('❌ 이미지 파일이 아닙니다:', file.type);
                    this.showToast('⚠️ 이미지 파일만 선택할 수 있습니다');
                    return;
                }
                
                const position = {
                    x: this.longPressPosition.x,
                    y: this.longPressPosition.y
                };

                this.showToast('🖼️ 사진 처리 중...');
                await this.addPhotoAt(file, position);
                
            } catch (error) {
                console.error('❌ 갤러리 입력 처리 오류:', error);
                this.showToast(`⚠️ 사진 추가 실패: ${error.message}`);
            } finally {
                e.target.value = ''; // 초기화
            }
        });
        
        // 텍스트 입력 모달
        const textCancelBtn = document.getElementById('text-cancel-btn');
        const textSaveBtn = document.getElementById('text-save-btn');
        
        if (textCancelBtn) {
            textCancelBtn.addEventListener('click', () => {
                this.hideTextInputModal();
            });
        }
        
        if (textSaveBtn) {
            textSaveBtn.addEventListener('click', () => {
                this.saveTextInput();
            });
        }

        const textEditCloseBtn = document.getElementById('text-edit-close');
        const textEditSaveBtn = document.getElementById('text-edit-save-btn');
        const textEditDeleteBtn = document.getElementById('text-edit-delete-btn');

        if (textEditCloseBtn) {
            textEditCloseBtn.addEventListener('click', () => {
                this.hideTextEditModal();
            });
        }

        if (textEditSaveBtn) {
            textEditSaveBtn.addEventListener('click', () => {
                this.saveTextEdit();
            });
        }

        if (textEditDeleteBtn) {
            textEditDeleteBtn.addEventListener('click', () => {
                this.deleteSelectedText();
            });
        }
        
        // 용량 조정 모달 이벤트 리스너
        const imageSizeCloseBtn = document.getElementById('image-size-close');
        const size500KBBtn = document.getElementById('size-500kb');
        const size1MBBtn = document.getElementById('size-1mb');
        const size2MBBtn = document.getElementById('size-2mb');
        const sizeOriginalBtn = document.getElementById('size-original');
        
        if (imageSizeCloseBtn) {
            imageSizeCloseBtn.addEventListener('click', () => {
                this.closeImageSizeModal();
            });
        }
        
        if (size500KBBtn) {
            size500KBBtn.addEventListener('click', () => {
                this.setImageSize('500KB');
            });
        }
        
        if (size1MBBtn) {
            size1MBBtn.addEventListener('click', () => {
                this.setImageSize('1MB');
            });
        }
        
        if (size2MBBtn) {
            size2MBBtn.addEventListener('click', () => {
                this.setImageSize('2MB');
            });
        }
        
        if (sizeOriginalBtn) {
            sizeOriginalBtn.addEventListener('click', () => {
                this.setImageSize('original');
            });
        }
        
        // 용량 조정 모달 외부 클릭 시 닫기
        const imageSizeModal = document.getElementById('image-size-modal');
        if (imageSizeModal) {
            imageSizeModal.addEventListener('click', (e) => {
                if (e.target === imageSizeModal) {
                    this.closeImageSizeModal();
                }
            });
        }
        
        // 컨텍스트 메뉴 외부 클릭/터치 시 닫기
        const handleOutsideClick = (e) => {
            const contextMenu = document.getElementById('context-menu');
            
            if (!contextMenu || !contextMenu.classList.contains('active')) {
                return;
            }
            
            // 컨텍스트 메뉴 외부를 클릭한 경우에만 닫기
            if (!contextMenu.contains(e.target)) {
                console.log('👆 메뉴 외부 클릭 - 메뉴 닫기');
                this.hideContextMenu();
            }
        };
        
        // SVG 영역 클릭 시 메뉴 닫기
        this.svg.addEventListener('touchstart', handleOutsideClick);
        this.svg.addEventListener('click', handleOutsideClick);
        
        // 사진 보기 모달 이벤트
        const closePhotoViewBtn = document.getElementById('close-photo-view');
        if (closePhotoViewBtn) {
            closePhotoViewBtn.addEventListener('click', () => {
                this.closePhotoViewModal();
            });
        } else {
            console.warn('⚠️ close-photo-view 버튼을 찾을 수 없습니다');
        }
        
        const deletePhotoViewBtn = document.getElementById('delete-photo-btn');
        if (deletePhotoViewBtn) {
            deletePhotoViewBtn.addEventListener('click', () => {
                this.deletePhoto();
            });
        } else {
            console.warn('⚠️ delete-photo-btn 버튼을 찾을 수 없습니다 (사진 보기 모달)');
        }
        
        // 재저장 버튼 이벤트
        const reuploadPhotoBtn = document.getElementById('reupload-photo-btn');
        if (reuploadPhotoBtn) {
            reuploadPhotoBtn.addEventListener('click', () => {
                this.reuploadPhoto();
            });
        } else {
            console.warn('⚠️ reupload-photo-btn 버튼을 찾을 수 없습니다');
        }
        
        // 사진 네비게이션 버튼 이벤트
        const photoPrevBtn = document.getElementById('photo-prev-btn');
        if (photoPrevBtn) {
            photoPrevBtn.addEventListener('click', () => {
                this.navigatePhoto(-1);
            });
        }
        
        const photoNextBtn = document.getElementById('photo-next-btn');
        if (photoNextBtn) {
            photoNextBtn.addEventListener('click', () => {
                this.navigatePhoto(1);
            });
        }
        
        // 사진 촬영 버튼 이벤트 (모달 내부)
        const capturePhotoBtn = document.getElementById('capture-photo-btn');
        if (capturePhotoBtn) {
            capturePhotoBtn.addEventListener('click', () => {
                this.capturePhotoAtCurrentLocation();
            });
        } else {
            console.warn('⚠️ capture-photo-btn 버튼을 찾을 수 없습니다');
        }

        this.setupPhotoMemoInlineEditing();

        window.addEventListener('drive-auth-changed', (event) => {
            const authenticated = !!event.detail?.authenticated;
            this.setLoginButtonState(authenticated);
            if (!this.driveStateInitialized) {
                this.driveStateInitialized = true;
                return;
            }
            if (!authenticated) {
                this.pendingLocalDriveSync = true;
                this.showToast('Google Drive 로그인이 만료되었습니다. 상단 버튼으로 다시 로그인하세요.');
            } else if (this.pendingLocalDriveSync) {
                this.pendingLocalDriveSync = false;
                this.showToast('Google Drive와 다시 연결되었습니다.');
            }
        });

    }
    
    /**
     * 롱프레스 이벤트 설정
     * 
     * ⚠️ 주의: 터치 이벤트는 setupEventListeners()의 onTouchStart/Move/End에서 통합 처리됨
     * 이 함수는 마우스 이벤트(데스크탑 테스트)만 처리
     */
    setupLongPressEvents() {
        // 마우스 이벤트 (데스크탑 테스트용)
        this.svg.addEventListener('mousedown', (e) => {
            if (e.button === 0) { // 좌클릭만
                this.startLongPress(e.clientX, e.clientY);
            }
        });
        
        this.svg.addEventListener('mousemove', () => {
            if (this.longPressTimer && !this.isDragging) {
                this.cancelLongPress();
            }
        });
        
        this.svg.addEventListener('mouseup', () => {
            this.cancelLongPress();
        });
    }
    
    /**
     * 롱프레스 시작
     */
    startLongPress(clientX, clientY) {
        // 기존 타이머 취소
        this.cancelLongPress();
        this.longPressTriggered = false;
        this.isLongPress = false;
        
        // 스크린 좌표 저장
        this.longPressPosition.screenX = clientX;
        this.longPressPosition.screenY = clientY;
        
        // ViewBox 좌표로 변환 (screenToViewBox 사용으로 정확도 향상)
        const viewCoords = this.screenToViewBox(clientX, clientY);
        
        this.longPressPosition.x = viewCoords.x;
        this.longPressPosition.y = viewCoords.y;
        
        // 타이머 시작
        this.longPressTimer = setTimeout(() => {
            this.onLongPress();
        }, this.longPressDuration);
    }
    
    /**
     * 롱프레스 취소
     */
    cancelLongPress() {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        this.longPressTriggered = false;
        this.isLongPress = false;
    }
    
    /**
     * 롱프레스 완료 시 실행
     */
    onLongPress() {
        console.log('🔔 롱프레스 감지!', this.longPressPosition);
        
        this.isLongPress = true;
        this.longPressTriggered = true;
        this.longPressTimer = null;
        
        // 햅틱 피드백 (지원하는 경우)
        if (navigator.vibrate) {
            navigator.vibrate(50);
        }
        
        // 컨텍스트 메뉴 표시
        this.showContextMenu(this.longPressPosition.screenX, this.longPressPosition.screenY);
    }
    
    /**
     * 컨텍스트 메뉴 표시
     */
    showContextMenu(screenX, screenY) {
        console.log('📋 컨텍스트 메뉴 표시 시작...');
        const contextMenu = document.getElementById('context-menu');
        
        if (!contextMenu) {
            console.error('❌ 컨텍스트 메뉴 요소를 찾을 수 없음!');
            return;
        }
        
        // 위치 설정 (화면을 벗어나지 않도록)
        const menuWidth = 200;
        const menuHeight = 180;
        
        let left = screenX;
        let top = screenY;
        
        // 오른쪽 벗어남 방지
        if (left + menuWidth > window.innerWidth) {
            left = window.innerWidth - menuWidth - 10;
        }
        
        // 아래쪽 벗어남 방지
        if (top + menuHeight > window.innerHeight) {
            top = window.innerHeight - menuHeight - 10;
        }
        
        contextMenu.style.left = left + 'px';
        contextMenu.style.top = top + 'px';
        contextMenu.classList.add('active');
        
        console.log(`✅ 컨텍스트 메뉴 표시됨 (위치: ${left}, ${top})`);
        
        // ⭐ 메뉴 표시 직후 이벤트 리스너 등록
        this.setupContextMenuListeners();
    }
    
    /**
     * 컨텍스트 메뉴 버튼 이벤트 리스너 등록 (메뉴 표시될 때마다 호출)
     */
    setupContextMenuListeners() {
        console.log('🎯 컨텍스트 메뉴 이벤트 리스너 등록 시작...');
        
        const cameraBtn = document.getElementById('camera-btn');
        const galleryBtn = document.getElementById('gallery-btn');
        const textBtn = document.getElementById('text-btn');
        
        if (!cameraBtn || !galleryBtn || !textBtn) {
            console.error('❌ 컨텍스트 메뉴 버튼을 찾을 수 없습니다!');
            return;
        }
        
        console.log('✅ 모든 버튼 요소 발견됨');
        
        // 기존 리스너 제거를 위해 클론 사용 (간단한 방법)
        const newCameraBtn = cameraBtn.cloneNode(true);
        const newGalleryBtn = galleryBtn.cloneNode(true);
        const newTextBtn = textBtn.cloneNode(true);
        
        cameraBtn.parentNode.replaceChild(newCameraBtn, cameraBtn);
        galleryBtn.parentNode.replaceChild(newGalleryBtn, galleryBtn);
        textBtn.parentNode.replaceChild(newTextBtn, textBtn);
        
        // 카메라 버튼
        const handleCamera = (e) => {
            console.log('📷 카메라 버튼 클릭!');
            e.preventDefault();
            e.stopPropagation();
            
            // 롱프레스 위치 확인
            console.log('   롱프레스 위치:', this.longPressPosition);
            
            // 메뉴 닫기
            this.hideContextMenu();
            
            // ⭐ iOS Safari에서는 사용자 제스처에서 직접 호출해야 함
            const cameraInput = document.getElementById('camera-input');
            console.log('📸 카메라 입력 요소:', cameraInput);
            
            if (cameraInput) {
                console.log('📸 카메라 입력 클릭 시도...');
                // 즉시 클릭 (setTimeout 없이)
                cameraInput.click();
                console.log('✅ 카메라 입력 클릭 완료');
            } else {
                console.error('❌ 카메라 입력 요소를 찾을 수 없음!');
            }
        };
        
        newCameraBtn.addEventListener('touchend', handleCamera, { passive: false });
        newCameraBtn.addEventListener('click', handleCamera);
        
        // 갤러리 버튼
        const handleGallery = (e) => {
            console.log('🖼️ 갤러리 버튼 클릭!');
            e.preventDefault();
            e.stopPropagation();
            
            // 롱프레스 위치 확인
            console.log('   롱프레스 위치:', this.longPressPosition);
            
            // 메뉴 닫기
            this.hideContextMenu();
            
            // ⭐ iOS Safari에서는 사용자 제스처에서 직접 호출해야 함
            const galleryInput = document.getElementById('gallery-input');
            console.log('🖼️ 갤러리 입력 요소:', galleryInput);
            
            if (galleryInput) {
                console.log('🖼️ 갤러리 입력 클릭 시도...');
                // 즉시 클릭 (setTimeout 없이)
                galleryInput.click();
                console.log('✅ 갤러리 입력 클릭 완료');
            } else {
                console.error('❌ 갤러리 입력 요소를 찾을 수 없음!');
            }
        };
        
        newGalleryBtn.addEventListener('touchend', handleGallery, { passive: false });
        newGalleryBtn.addEventListener('click', handleGallery);
        
        // 텍스트 버튼
        const handleText = (e) => {
            console.log('📝 텍스트 버튼 클릭!');
            e.preventDefault();
            e.stopPropagation();
            
            // 롱프레스 위치 확인
            console.log('   롱프레스 위치:', this.longPressPosition);
            
            // 메뉴 닫기
            this.hideContextMenu();
            
            // 즉시 텍스트 모달 표시
            console.log('📝 텍스트 모달 표시 시도...');
            this.showTextInputModal();
        };
        
        newTextBtn.addEventListener('touchend', handleText, { passive: false });
        newTextBtn.addEventListener('click', handleText);
        
        console.log('✅ 모든 이벤트 리스너 등록 완료');
    }
    
    /**
     * 컨텍스트 메뉴 숨김
     */
    hideContextMenu() {
        const contextMenu = document.getElementById('context-menu');
        if (contextMenu) {
            contextMenu.classList.remove('active');
        }
        
    }
    
    /**
     * 텍스트 입력 모달 표시
     */
    showTextInputModal() {
        console.log('📝 텍스트 입력 모달 표시 시도...');
        const modal = document.getElementById('text-input-modal');
        const textField = document.getElementById('text-input-field');
        
        if (!modal) {
            console.error('❌ 텍스트 모달 요소를 찾을 수 없음!');
            return;
        }
        
        if (!textField) {
            console.error('❌ 텍스트 입력 필드를 찾을 수 없음!');
            return;
        }
        
        textField.value = '';
        modal.classList.add('active');
        console.log('✅ 텍스트 입력 모달 표시됨');
        
        // 포커스
        setTimeout(() => {
            textField.focus();
            console.log('⌨️ 텍스트 필드 포커스 설정');
        }, 100);
    }
    
    /**
     * 텍스트 입력 모달 숨김
     */
    hideTextInputModal() {
        const modal = document.getElementById('text-input-modal');
        if (modal) {
            modal.classList.remove('active');
        }
    }
    
    /**
     * 텍스트 저장
     */
    saveTextInput() {
        const textField = document.getElementById('text-input-field');
        const text = textField.value.trim();
        
        if (!text) {
            alert('텍스트를 입력하세요.');
            return;
        }
        
        // 텍스트 객체 생성
        const textObj = {
            id: Date.now(),
            x: this.longPressPosition.x,
            y: this.longPressPosition.y,
            text: text,
            fontSize: 50 // 고정 크기 (AutoCAD 호환용, 웹에서는 18px로 표시)
        };
        
        this.texts.push(textObj);
        this.metadataDirty = true;
        
        console.log('📝 텍스트 추가:', textObj);
        
        this.hideTextInputModal();
        this.redraw();

        
        // Google Drive 자동 저장
        this.autoSave();
    }

    openTextEditModal(textId) {
        const modal = document.getElementById('text-edit-modal');
        const textField = document.getElementById('text-edit-field');
        
        if (!modal || !textField) {
            console.warn('⚠️ 텍스트 편집 모달 요소를 찾을 수 없습니다');
            return;
        }

        const targetText = this.texts.find(t => t.id === textId);
        if (!targetText) {
            console.warn('⚠️ 편집할 텍스트를 찾을 수 없습니다:', textId);
            return;
        }

        this.selectedTextId = textId;
        textField.value = targetText.text || '';
        modal.classList.add('active');

        setTimeout(() => {
            textField.focus({ preventScroll: true });
        }, 100);
    }

    hideTextEditModal() {
        const modal = document.getElementById('text-edit-modal');
        const textField = document.getElementById('text-edit-field');

        if (modal) {
            modal.classList.remove('active');
        }

        if (textField) {
            textField.value = '';
        }

        this.selectedTextId = null;
    }

    saveTextEdit() {
        if (!this.selectedTextId) {
            this.hideTextEditModal();
            return;
        }

        const textField = document.getElementById('text-edit-field');
        if (!textField) return;

        const newValue = textField.value.trim();
        if (!newValue) {
            alert('텍스트를 입력하세요.');
            return;
        }

        const targetText = this.texts.find(t => t.id === this.selectedTextId);
        if (!targetText) {
            this.hideTextEditModal();
            return;
        }

        if (targetText.text !== newValue) {
            targetText.text = newValue;
            this.metadataDirty = true;
            this.redraw();
            this.autoSave();
            this.showToast('✅ 텍스트가 수정되었습니다.');
        }

        this.hideTextEditModal();
    }

    deleteSelectedText() {
        if (!this.selectedTextId) {
            return;
        }

        const textIndex = this.texts.findIndex(t => t.id === this.selectedTextId);
        if (textIndex === -1) {
            this.hideTextEditModal();
            return;
        }

        if (!confirm('선택한 텍스트를 삭제하시겠습니까?')) {
            return;
        }

        this.texts.splice(textIndex, 1);
        this.metadataDirty = true;
        this.hideTextEditModal();
        this.redraw();
        this.autoSave();
        this.showToast('🗑️ 텍스트가 삭제되었습니다.');
    }
    
    /**
     * GitHub에서 프로그램을 다시 로드 (캐시 무시)
     */
    async reloadFromGitHub() {
        try {
            console.log('🔄 GitHub에서 프로그램 다시 로드 시작...');
            this.showToast('🔄 최신 버전 로드 중...');
            
            // Service Worker 캐시 삭제 (있는 경우)
            if ('caches' in window) {
                try {
                    const cacheNames = await caches.keys();
                    for (const cacheName of cacheNames) {
                        await caches.delete(cacheName);
                        console.log(`✅ 캐시 삭제: ${cacheName}`);
                    }
                } catch (error) {
                    console.warn('⚠️ 캐시 삭제 중 오류:', error);
                }
            }
            
            // Service Worker 등록 해제 (있는 경우)
            if ('serviceWorker' in navigator) {
                try {
                    const registrations = await navigator.serviceWorker.getRegistrations();
                    for (const registration of registrations) {
                        await registration.unregister();
                        console.log('✅ Service Worker 등록 해제');
                    }
                } catch (error) {
                    console.warn('⚠️ Service Worker 해제 중 오류:', error);
                }
            }
            
            // 잠시 대기 후 페이지 새로고침 (캐시 무시)
            await new Promise(resolve => setTimeout(resolve, 300));
            
            // 쿼리 파라미터를 추가하여 강제 새로고침 (캐시 무시)
            const url = new URL(window.location.href);
            url.searchParams.set('reload', Date.now().toString());
            url.searchParams.set('backToList', 'true'); // 목록 화면으로 돌아갈 것을 표시
            
            // 페이지 새로고침 (캐시 무시)
            window.location.href = url.toString();
            
        } catch (error) {
            console.error('❌ GitHub에서 다시 로드 실패:', error);
            // 오류 발생 시 일반 새로고침 시도
            window.location.reload(true);
        }
    }
    
    /**
     * 화면 전환: 파일 목록 표시
     */
    showFileList() {
        this.fileListScreen.classList.remove('hidden');
        this.viewerScreen.classList.add('hidden');
        this.viewerUI.classList.add('hidden'); // UI 버튼들 숨김
        this.closeSlideMenu(); // 메뉴 닫기
    }
    
    /**
     * 화면 전환: 뷰어 표시
     */
    showViewer() {
        console.log('🖼️ 뷰어 화면으로 전환');
        
        this.fileListScreen.classList.add('hidden');
        this.viewerScreen.classList.remove('hidden');
        
        if (this.viewerUI) {
            this.viewerUI.classList.remove('hidden'); // UI 버튼들 표시
            console.log('✅ 뷰어 UI 표시');
        } else {
            console.error('❌ viewerUI 요소를 찾을 수 없음!');
        }
    }
    
    /**
     * 슬라이딩 메뉴 토글
     */
    toggleSlideMenu() {
        const slideMenu = document.getElementById('slide-menu');
        const overlay = document.getElementById('menu-overlay');
        
        if (!slideMenu || !overlay) {
            console.warn('⚠️ 슬라이딩 메뉴 요소를 찾을 수 없습니다');
            return;
        }
        
        const isActive = slideMenu.classList.contains('active');
        
        if (isActive) {
            this.closeSlideMenu();
        } else {
            this.openSlideMenu();
        }
    }
    
    /**
     * 슬라이딩 메뉴 열기
     */
    openSlideMenu() {
        const slideMenu = document.getElementById('slide-menu');
        const overlay = document.getElementById('menu-overlay');
        
        if (slideMenu && overlay) {
            slideMenu.classList.add('active');
            overlay.classList.add('active');
        }
    }
    
    /**
     * 슬라이딩 메뉴 닫기
     */
    closeSlideMenu() {
        const slideMenu = document.getElementById('slide-menu');
        const overlay = document.getElementById('menu-overlay');
        
        if (slideMenu && overlay) {
            slideMenu.classList.remove('active');
            overlay.classList.remove('active');
        }
    }
    
    /**
     * 캐시 삭제 및 현재 도면 새로고침
     */
    async clearCacheAndReload() {
        try {
            console.log('🗑️ 캐시 삭제 시작...');
            this.showLoading(true);
            
            // Service Worker 캐시 삭제
            if ('caches' in window) {
                const cacheNames = await caches.keys();
                console.log(`📦 발견된 캐시: ${cacheNames.length}개`);
                
                for (const cacheName of cacheNames) {
                    await caches.delete(cacheName);
                    console.log(`✅ 캐시 삭제됨: ${cacheName}`);
                }
            }
            
            // 현재 도면 정보 저장
            const currentDxfData = this.dxfData;
            const currentPhotos = [...this.photos];
            const currentViewBox = {...this.viewBox};
            const currentFileName = this.currentFileName;
            const currentFileId = this.currentFileId;
            
            console.log('💾 현재 도면 상태 저장 완료');
            console.log(`  - 파일명: ${currentFileName}`);
            console.log(`  - 사진 개수: ${currentPhotos.length}`);
            
            // 잠시 대기 (캐시 삭제 완료 확인)
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // 현재 도면 다시 로드
            if (currentDxfData) {
                console.log('🔄 도면 새로고침 중...');
                
                // 도면 정보 복원
                this.dxfData = currentDxfData;
                this.photos = currentPhotos;
                this.viewBox = currentViewBox;
                this.currentFileName = currentFileName;
                this.currentFileId = currentFileId;
                
                // 화면 다시 그리기
                this.redraw();
                
                console.log('✅ 캐시 삭제 및 새로고침 완료');
                alert('캐시가 삭제되었습니다.');
            } else {
                console.log('⚠️ 현재 열린 도면이 없습니다.');
                alert('캐시가 삭제되었습니다.');
            }
            
            this.showLoading(false);
            
        } catch (error) {
            console.error('❌ 캐시 삭제 실패:', error);
            alert('캐시 삭제 중 오류가 발생했습니다.');
            this.showLoading(false);
        }
    }
    
    /**
     * Google Drive 로그인 처리
     */
    async handleLogin() {
        try {
            this.showLoading(true);
            
            if (!window.driveManager) {
                throw new Error('Google Drive Manager가 초기화되지 않았습니다.\n\n페이지를 새로고침해주세요.');
            }
            
            console.log('🔑 로그인 시도 중...');
            
            // 인증 요청
            const success = await window.authenticateGoogleDrive();
            
            if (!success) {
                throw new Error('인증에 실패했습니다');
            }
            
            console.log('✅ 로그인 성공');
            console.log('액세스 토큰:', window.driveManager.accessToken ? '있음' : '없음');
            
            // 토큰 설정을 위해 짧은 대기
            await new Promise(resolve => setTimeout(resolve, 500));
            
            this.showLoading(false);
            
            // 로그인 성공 후 파일 목록 로드
            await this.loadFileList();
            
        } catch (error) {
            this.showLoading(false);
            console.error('❌ 로그인 실패:', error);
            alert('로그인에 실패했습니다.\n\n' + error.message + '\n\n브라우저 팝업 차단을 해제하고 다시 시도해주세요.');
        }
    }
    
    /**
     * 파일 목록 로드 (모든 파일)
     */
    async loadFileList() {
        try {
            this.showLoading(true);
            
            console.log('📂 파일 목록 로드 시작...');
            console.log('driveManager 존재:', !!window.driveManager);
            console.log('accessToken 존재:', !!window.driveManager?.accessToken);
            
            if (!window.driveManager || !window.driveManager.listFiles) {
                throw new Error('Google Drive가 초기화되지 않았습니다.\n\n페이지를 새로고침해주세요.');
            }
            
            if (!window.driveManager.accessToken) {
                throw new Error('로그인이 필요합니다.\n\n먼저 로그인 버튼을 클릭해주세요.');
            }
            
            // 모든 파일 목록 가져오기 (DXF만이 아닌)
            const files = await window.driveManager.listFiles();
            
            console.log('✅ 파일 목록 로드 성공:', files.length + '개');
            
            this.showLoading(false);
            
            // UI 업데이트
            this.renderFileList(files);
            this.setLoginButtonState(true);
            
        } catch (error) {
            this.showLoading(false);
            console.error('❌ 파일 목록 로드 실패:', error);
            console.error('상세 오류:', error.message);
            
            alert('파일 목록을 불러오는데 실패했습니다.\n\n' + error.message + '\n\n다시 로그인해주세요.');
            
            this.setLoginButtonState(false);
        }
    }
    
    setLoginButtonState(isLoggedIn) {
        const btn = document.getElementById('login-btn');
        if (!btn) return;
        btn.textContent = isLoggedIn ? '✅ 로그인됨' : '🔐 Google Drive';
        btn.style.background = isLoggedIn ? '#34C759' : '#4285F4';
    }

    setupPhotoMemoInlineEditing() {
        if (!this.photoMemoInput) {
            console.warn('⚠️ photo-memo-input 요소를 찾을 수 없습니다');
            return;
        }

        this.photoMemoInput.addEventListener('input', () => {
            if (!this.selectedPhotoId) return;
            const photo = this.photos.find(p => p.id === this.selectedPhotoId);
            if (!photo) return;
            photo.memo = this.photoMemoInput.value;
            this.metadataDirty = true;
        });

        this.photoMemoInput.addEventListener('blur', () => {
            this.saveInlineMemo();
        });
    }

    saveInlineMemo() {
        if (!this.photoMemoInput || !this.selectedPhotoId) return;

        const photo = this.photos.find(p => p.id === this.selectedPhotoId);
        if (!photo) return;

        const newMemo = this.photoMemoInput.value || '';
        if (photo.memo !== newMemo) {
            photo.memo = newMemo;
            this.metadataDirty = true;
            this.redraw();
        }

        if (this.metadataDirty) {
            this.autoSave();
        }
    }

    /**
     * 파일 목록 UI 렌더링
     */
    renderFileList(files) {
        const fileListDiv = document.getElementById('file-list');
        
        if (!files || files.length === 0) {
            fileListDiv.innerHTML = '<p class="info-text">📭 파일이 없습니다.</p>';
            return;
        }
        
        // 정렬: DXF 파일을 상단에, 나머지는 이름순
        const sortedFiles = [...files].sort((a, b) => {
            const aIsDxf = a.name.toLowerCase().endsWith('.dxf');
            const bIsDxf = b.name.toLowerCase().endsWith('.dxf');
            
            // DXF 파일을 먼저
            if (aIsDxf && !bIsDxf) return -1;
            if (!aIsDxf && bIsDxf) return 1;
            
            // 같은 타입이면 이름순 (대소문자 구분 없이)
            return a.name.localeCompare(b.name, 'ko', { sensitivity: 'base' });
        });
        
        fileListDiv.innerHTML = '';
        
        sortedFiles.forEach(file => {
            const isDxf = file.name.toLowerCase().endsWith('.dxf');
            const isImage = /\.(jpg|jpeg|png|gif)$/i.test(file.name);
            const isMetadata = file.name.endsWith('_metadata.json');
            
            // 메타데이터 파일은 숨김
            if (isMetadata) return;
            
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';
            
            // 파일 타입별 아이콘
            let icon = '📄';
            if (isDxf) icon = '📐';
            else if (isImage) icon = '🖼️';
            
            fileItem.innerHTML = `
                <div class="file-item-name">${icon} ${file.name}</div>
                <div class="file-item-date">${new Date(file.modifiedTime).toLocaleString('ko-KR')}</div>
            `;
            
            fileItem.addEventListener('click', async () => {
                if (isDxf) {
                    // DXF 파일은 뷰어로 열기
                    await this.openDxfFromDrive(file);
                } else if (isImage) {
                    // 이미지 파일은 현재 탭에서 열기
                    this.showToast('🖼️ 이미지 로딩 중...');
                    try {
                        const blob = await window.driveManager.downloadFileAsBlob(file.id);
                        const blobUrl = URL.createObjectURL(blob);
                        
                        // 현재 탭에서 이미지 열기 (뒤로 가기로 복귀 가능)
                        window.location.href = blobUrl;
                    } catch (error) {
                        console.error('이미지 열기 실패:', error);
                        this.showToast('⚠️ 이미지 열기 실패');
                    }
                } else {
                    // 다른 파일은 현재 탭에서 열기
                    this.showToast('📄 파일 로딩 중...');
                    try {
                        const blob = await window.driveManager.downloadFileAsBlob(file.id);
                        const blobUrl = URL.createObjectURL(blob);
                        
                        // 현재 탭에서 파일 열기 (뒤로 가기로 복귀 가능)
                        window.location.href = blobUrl;
                    } catch (error) {
                        console.error('파일 열기 실패:', error);
                        this.showToast('⚠️ 파일 열기 실패');
                    }
                }
            });
            
            fileListDiv.appendChild(fileItem);
        });
    }
    
    /**
     * Google Drive에서 DXF 파일 열기
     */
    async openDxfFromDrive(file) {
        try {
            // 먼저 뷰어 화면으로 전환
            this.showViewer();
            
            this.showLoading(true);
            
            // 파일 다운로드
            const fileContent = await window.downloadDxfFile(file.id);
            
            // 현재 파일 정보 저장
            window.currentDriveFile = {
                id: file.id,
                name: file.name
            };
            
            console.log('📁 현재 드라이브 파일 설정됨:', window.currentDriveFile);
            
            // 사진/텍스트 데이터 초기화 (메타데이터 로드 전)
            this.photos = [];
            this.texts = [];
            this.metadataDirty = false;
            
            // DXF 파싱 및 렌더링
            this.loadDxfFromText(fileContent, file.name);
            
            // 메타데이터 로드 및 사진/텍스트 표시
            await this.loadMetadataAndDisplay(file.name);
            
            this.showLoading(false);
            
        } catch (error) {
            this.showLoading(false);
            console.error('파일 열기 실패:', error);
            alert('파일을 여는데 실패했습니다: ' + error.message);
            
            // 오류 시 다시 파일 목록으로
            this.showFileList();
        }
    }
    
    /**
     * 메타데이터 로드 및 사진/텍스트 표시
     */
    async loadMetadataAndDisplay(dxfFileName) {
        try {
            console.log('📋 메타데이터 로드 시작:', dxfFileName);
            
            if (!window.driveManager || !window.driveManager.loadMetadata) {
                console.warn('⚠️ Google Drive 메타데이터 기능 없음');
                return;
            }
            
            const metadata = await window.driveManager.loadMetadata(dxfFileName);
            
            if (!metadata || (!metadata.photos && !metadata.texts)) {
                console.log('   메타데이터 없음');
                return;
            }
            
            console.log('✅ 메타데이터 로드 완료:', {
                photosCount: metadata.photos?.length || 0,
                textsCount: metadata.texts?.length || 0
            });
            
            // 사진 로드
            if (metadata.photos && metadata.photos.length > 0) {
                console.log('📷 사진 메타데이터 복원:', metadata.photos.length + '개');
                
                metadata.photos.forEach(photoMeta => {
                    const basePhoto = {
                        id: photoMeta.id,
                        x: photoMeta.position?.x ?? 0,
                        y: photoMeta.position?.y ?? 0,
                        width: photoMeta.size?.width ?? 1,
                        height: photoMeta.size?.height ?? 1,
                        imageData: null,
                        image: null,
                        memo: photoMeta.memo || '',
                        fileName: photoMeta.fileName,
                        uploaded: true
                    };
                    
                    this.photos.push(basePhoto);
                });
                
                console.log('✅ 사진 좌표 복원 완료:', this.photos.length + '개');
            }
            
            // 텍스트 로드
            if (metadata.texts && metadata.texts.length > 0) {
                console.log('📝 텍스트 복원:', metadata.texts.length + '개');
                this.texts = metadata.texts;
            }
            
            // 화면 다시 그리기
            this.redraw();
            
            if (this.photos.length > 0 || this.texts.length > 0) {
                this.showToast(`✅ 데이터 로드 완료 (사진: ${this.photos.length}, 텍스트: ${this.texts.length})`);
            }
            
            this.metadataDirty = false;
            
        } catch (error) {
            console.error('❌ 메타데이터 로드 실패:', error);
            // 실패해도 계속 진행 (선택적 기능)
        }
    }
    
    showLoading(show) {
        const loading = document.getElementById('loading');
        if (loading) {
            loading.classList.toggle('active', show);
        }
    }
    
    /**
     * Google Drive에서 가져온 텍스트로 DXF 로드
     * @param {string} text - DXF 파일 텍스트 내용
     * @param {string} fileName - 파일 이름
     */
    loadDxfFromText(text, fileName) {
        this.showLoading(true);
        
        try {
            this._parseDxf(text, fileName);
        } catch (error) {
            console.error('DXF 텍스트 로드 오류:', error);
            alert('DXF 파일 처리 실패: ' + error.message);
        } finally {
            this.showLoading(false);
        }
    }
    
    async loadDxfFile(file) {
        if (!file) return;
        
        this.showLoading(true);
        
        try {
            // 로컬 파일 정보 기억
            window.currentDriveFile = {
                id: null,
                name: file.name,
                source: 'local'
            };
            this.localSourceFile = file;
            
            // 사진/텍스트 데이터 초기화 (메모리 정리)
            if (this.photos.length > 0) {
                this.photos.forEach(photo => {
                    photo.imageData = null; // 메모리 해제
                });
            }
            this.photos = [];
            this.texts = [];
            this.metadataDirty = false;
            this.debugLog('   사진/텍스트 데이터 초기화 완료');
            
            await this.ensureDriveContextForLocalFile(file);
            
            // 1. 파일 읽기
            const text = await file.text();
            
            this._parseDxf(text, file.name);
            
            if (window.driveManager?.isAccessTokenValid()) {
                await this.syncLocalDxfToDrive(file);
                await this.loadMetadataAndDisplay(file.name);
            } else {
                this.pendingLocalDriveSync = true;
                this.showToast('Google Drive 로그인 후 사진/메모가 동기화됩니다.');
            }
            
        } catch (error) {
            console.error('DXF 파일 로드 오류:', error);
            alert('DXF 파일을 여는데 실패했습니다.');
        } finally {
            this.showLoading(false);
        }
    }
    
    async ensureDriveContextForLocalFile(file) {
        if (!file) {
            return;
        }
        
        if (!window.driveManager) {
            await window.initGoogleDrive?.();
        }
        
        if (!window.currentDriveFile) {
            window.currentDriveFile = {
                id: null,
                name: file.name,
                source: 'local'
            };
        } else {
            window.currentDriveFile.name = file.name;
            window.currentDriveFile.source = 'local';
        }
        
        if (!window.driveManager) {
            return;
        }
        
        if (window.driveManager.isAccessTokenValid()) {
            this.setLoginButtonState(true);
            return;
        }
        
        if (this.localDriveRequestInProgress) {
            return;
        }
        
        this.localDriveRequestInProgress = true;
        try {
            if (!this.hasPromptedLocalDriveLogin) {
                this.showToast('Google Drive 로그인을 진행하면 로컬 도면도 자동 저장됩니다.');
                this.hasPromptedLocalDriveLogin = true;
            }
            const success = await window.authenticateGoogleDrive();
            if (!success) {
                this.pendingLocalDriveSync = true;
                this.showToast('로그인 후에만 사진/메모가 Drive에 저장됩니다.');
            } else {
                this.setLoginButtonState(true);
            }
        } catch (error) {
            console.warn('로컬 파일을 위한 Google Drive 로그인 실패:', error);
            this.pendingLocalDriveSync = true;
        } finally {
            this.localDriveRequestInProgress = false;
        }
    }
    
    async syncLocalDxfToDrive(file) {
        if (!file || !window.driveManager || !window.driveManager.isAccessTokenValid()) {
            return;
        }
        
        try {
            const existing = await window.driveManager.findFileByName(file.name);
            if (existing) {
                window.currentDriveFile.id = existing.id;
                return;
            }
            
            this.showToast('☁️ 로컬 도면을 Google Drive에 업로드합니다...');
            const uploadResult = await window.driveManager.uploadFile(
                file.name,
                file,
                file.type || 'application/dxf'
            );
            window.currentDriveFile.id = uploadResult.id;
            this.showToast('✅ 도면이 Google Drive에 저장되었습니다.');
        } catch (error) {
            console.warn('로컬 도면 업로드 실패:', error);
            this.showToast('⚠️ 도면 업로드에 실패했습니다. 네트워크를 확인하세요.');
        }
    }
    
    /**
     * DXF 텍스트 파싱 (공통 로직)
     * @param {string} text - DXF 텍스트
     * @param {string} fileName - 파일 이름
     */
    _parseDxf(text, fileName) {
        // 1. Canvas 크기 재설정 (화면 전환 후 크기가 달라질 수 있음)
        const rect = this.container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            this.canvas.width = rect.width;
            this.canvas.height = rect.height;
        }
        
        // 2. DXF 파일 유효성 검사
        if (!text.includes('SECTION') || !text.includes('ENTITIES')) {
            throw new Error('올바른 DXF 파일 형식이 아닙니다.');
        }
        
        // 3. DXF 버전 확인
        const versionMatch = text.match(/\$ACADVER[\s\S]*?[\r\n]\s*1[\r\n]\s*AC(\d+)/);
        const version = versionMatch ? versionMatch[1] : 'Unknown';
        console.log('DXF 버전:', version);
        
        // 4. DXF 파싱
        if (typeof DxfParser === 'undefined') {
            throw new Error('DXF 파서 라이브러리가 로드되지 않았습니다.\n\n페이지를 새로고침(F5)하거나 인터넷 연결을 확인해주세요.');
        }
        
        const parser = new DxfParser();
        this.dxfData = parser.parseSync(text);
        
        // 원본 DXF 텍스트 저장 (constantWidth 추출용)
        this.dxfText = text;
            
        // 5. 파싱된 데이터 검증
        if (!this.dxfData) {
            throw new Error('DXF 파일 파싱에 실패했습니다.');
        }
        
        // 5-1. constantWidth 값 수동 추출 (파서가 파싱하지 못하는 경우 대비)
        this._extractConstantWidths();
        
        // 엔티티가 없는 경우 경고
        if (!this.dxfData.entities || this.dxfData.entities.length === 0) {
            console.warn('DXF 파일에 엔티티가 없습니다.');
            if (!confirm('도면에 그려진 내용이 없는 것 같습니다. 계속하시겠습니까?')) {
                return;
            }
        }
            
        console.log('DXF 데이터:', this.dxfData);
        console.log('엔티티 개수:', this.dxfData.entities ? this.dxfData.entities.length : 0);
        
        // 색상 정보 확인 (처음 5개 엔티티)
        if (this.dxfData.entities && this.dxfData.entities.length > 0) {
            console.log('\n🎨 엔티티 색상 정보 (처음 5개):');
            this.dxfData.entities.slice(0, 5).forEach((entity, i) => {
                console.log(`  ${i}. ${entity.type}: color=${entity.color}, colorIndex=${entity.colorIndex}`);
            });
        }
        
            
        // 레이어 정보 표시 (상세)
        if (this.dxfData.tables) {
            console.log('\nTables 키:', Object.keys(this.dxfData.tables));
            
            // ⭐ 새로 추가: 실제 구조 확인
            console.log('\n🔍 레이어 테이블 실제 구조:');
            const layersObj = this.dxfData.tables.layers || this.dxfData.tables.layer;
            console.log('layersObj 타입:', Array.isArray(layersObj) ? 'Array' : typeof layersObj);
            console.log('layersObj 전체:', layersObj);
            
            // ⭐ 각 가능한 구조 확인
            if (layersObj) {
                // 1. 객체인 경우
                if (!Array.isArray(layersObj) && typeof layersObj === 'object') {
                    console.log('✅ 객체 형태의 레이어 테이블');
                    Object.keys(layersObj).slice(0, 5).forEach(name => {
                        const layer = layersObj[name];
                        console.log(`  "${name}":`, layer);
                    });
                }
                
                // 2. layers 속성이 있는 경우
                if (layersObj.layers) {
                    console.log('✅ layers 속성 발견');
                    console.log('layersObj.layers 타입:', Array.isArray(layersObj.layers) ? 'Array' : typeof layersObj.layers);
                    
                    // 2-1. 객체인 경우 레이어 목록 출력 (처음 10개)
                    if (typeof layersObj.layers === 'object' && !Array.isArray(layersObj.layers)) {
                        const layerNames = Object.keys(layersObj.layers);
                        console.log(`   → 레이어 개수: ${layerNames.length}개`);
                        console.log('   → 레이어 색상 정보 (처음 10개):');
                        layerNames.slice(0, 10).forEach(name => {
                            const layer = layersObj.layers[name];
                            console.log(`      "${name}": colorIndex=${layer.colorIndex}, color=${layer.color}`);
                        });
                    }
                    // 2-2. 배열인 경우
                    else if (Array.isArray(layersObj.layers)) {
                        console.log(`   → 레이어 개수: ${layersObj.layers.length}개`);
                        console.log('   → 레이어 색상 정보 (처음 10개):');
                        layersObj.layers.slice(0, 10).forEach((layer, i) => {
                            console.log(`      [${i}] "${layer.name}": colorIndex=${layer.colorIndex}, color=${layer.color}`);
                        });
                    }
                }
                
                // 3. 배열인 경우
                if (Array.isArray(layersObj)) {
                    console.log('✅ 배열 형태의 레이어 테이블');
                    console.log(`   → 레이어 개수: ${layersObj.length}개`);
                    layersObj.slice(0, 5).forEach((layer, i) => {
                        console.log(`  [${i}] "${layer.name}": colorIndex=${layer.colorIndex}`, layer);
                    });
                }
            }
        }
        
        // 블록 정보 표시
        if (this.dxfData.blocks) {
            const blockNames = Object.keys(this.dxfData.blocks);
            console.log('\n📦 블록 개수:', blockNames.length);
            if (blockNames.length > 0) {
                console.log('블록 목록:', blockNames.slice(0, 10));
                blockNames.slice(0, 5).forEach(name => {
                    const block = this.dxfData.blocks[name];
                    if (block.entities) {
                        console.log(`  - ${name}: ${block.entities.length}개 엔티티`);
                    }
                });
            }
        }
        
        this.dxfFileName = fileName.replace('.dxf', '');
        
        // 파일명 UI 업데이트
        this.updateFileNameDisplay(fileName);
        
        // 캔버스 초기화
        this.photos = [];
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        
        // 디버그 카운터 리셋
        this.colorDebugCount = 0;
        this._blockDebugCount = 0;
        this._textDebugCount = 0;
        
        // DXF 렌더링
        this.fitDxfToView();
        this.redraw();
    }
    
    /**
     * DXF 원본 텍스트에서 constantWidth 값을 추출하여 엔티티에 추가
     * DXF 파서가 constantWidth를 파싱하지 못하는 경우를 대비
     */
    _extractConstantWidths() {
        if (!this.dxfText || !this.dxfData || !this.dxfData.entities) {
            return;
        }
        
        const lines = this.dxfText.split(/\r?\n/);
        let foundCount = 0;
        
        // 1단계: 원본 텍스트에서 모든 LWPOLYLINE/POLYLINE의 constantWidth 추출
        const constantWidthMap = []; // { layer, constantWidth, firstVertex } 배열
        let inEntity = false;
        let currentLayer = '';
        let constantWidth = null;
        let entityType = '';
        let firstVertexX = null;
        let firstVertexY = null;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line === 'LWPOLYLINE' || line === 'POLYLINE') {
                // 이전 엔티티 저장 (constantWidth가 null이 아닌 경우만, 0도 포함)
                if (inEntity && constantWidth !== null && currentLayer) {
                    constantWidthMap.push({
                        layer: currentLayer,
                        constantWidth: constantWidth,
                        type: entityType,
                        firstVertex: firstVertexX !== null && firstVertexY !== null ? { x: firstVertexX, y: firstVertexY } : null
                    });
                }
                // 새 엔티티 시작
                inEntity = true;
                entityType = line;
                currentLayer = '';
                constantWidth = null; // null로 초기화 (0과 구분)
                firstVertexX = null;
                firstVertexY = null;
            } else if (inEntity) {
                if (line === '8' && i + 1 < lines.length) {
                    currentLayer = lines[i + 1].trim();
                } else if (line === '100' && i + 1 < lines.length && lines[i + 1].trim() === 'AcDbPolyline') {
                    // AcDbPolyline 발견 - 이제 코드 43을 찾을 준비
                    // AcDbPolyline 이후의 코드 순서: 90, 70, 43 (또는 다른 순서일 수 있음)
                    // 코드 43을 찾기 위해 다음 몇 줄을 확인
                    let foundAcDbPolyline = true;
                    // AcDbPolyline 이후 코드 43 찾기 (최대 10줄까지 확인)
                    for (let j = i + 2; j < Math.min(i + 20, lines.length); j++) {
                        const nextLine = lines[j].trim();
                        if (nextLine === '43' && j + 1 < lines.length) {
                            try {
                                const val = parseFloat(lines[j + 1].trim());
                                if (!isNaN(val)) {
                                    // 0 이상의 모든 값 저장 (0.04, 0.05 등 포함, 0도 포함하여 구분)
                                    constantWidth = val;
                                    break; // 찾았으므로 중단
                                }
                            } catch (e) {
                                // 무시
                            }
                        } else if (nextLine === '10') {
                            // 코드 10을 만나면 코드 43을 찾는 범위를 벗어남
                            break;
                        }
                    }
                } else if (line === '43' && i + 1 < lines.length && constantWidth === null) {
                    // AcDbPolyline 이후 찾지 못한 경우, 일반적인 방법으로 찾기
                    try {
                        const val = parseFloat(lines[i + 1].trim());
                        if (!isNaN(val)) {
                            // 0 이상의 모든 값 저장 (0.04, 0.05 등 포함, 0도 포함하여 구분)
                            constantWidth = val;
                        }
                    } catch (e) {
                        // 무시
                    }
                } else if (line === '10' && i + 1 < lines.length && firstVertexX === null) {
                    // 첫 번째 정점 X 좌표
                    try {
                        firstVertexX = parseFloat(lines[i + 1].trim());
                    } catch (e) {
                        // 무시
                    }
                } else if (line === '20' && i + 1 < lines.length && firstVertexX !== null && firstVertexY === null) {
                    // 첫 번째 정점 Y 좌표
                    try {
                        firstVertexY = parseFloat(lines[i + 1].trim());
                    } catch (e) {
                        // 무시
                    }
                } else if (line === '0' || line === 'SEQEND') {
                    // 엔티티 종료
                    if (constantWidth !== null && currentLayer) {
                        constantWidthMap.push({
                            layer: currentLayer,
                            constantWidth: constantWidth,
                            type: entityType,
                            firstVertex: firstVertexX !== null && firstVertexY !== null ? { x: firstVertexX, y: firstVertexY } : null
                        });
                    }
                    inEntity = false;
                    currentLayer = '';
                    constantWidth = null;
                    firstVertexX = null;
                    firstVertexY = null;
                }
            }
        }
        
        // 마지막 엔티티 처리
        if (inEntity && constantWidth !== null && currentLayer) {
            constantWidthMap.push({
                layer: currentLayer,
                constantWidth: constantWidth,
                type: entityType,
                firstVertex: firstVertexX !== null && firstVertexY !== null ? { x: firstVertexX, y: firstVertexY } : null
            });
        }
        
        // 2단계: 파싱된 엔티티와 매칭
        
        let mapIndex = 0;
        let entityIndex = 0;
        this.dxfData.entities.forEach((entity) => {
            if (entity.type !== 'LWPOLYLINE' && entity.type !== 'POLYLINE') {
                return;
            }
            
            entityIndex++;
            
            // 이미 constantWidth가 있으면 스킵
            if (entity.constantWidth !== undefined && entity.constantWidth !== null) {
                return;
            }
            
            // 같은 타입, 같은 레이어의 엔티티 찾기
            let matched = false;
            let bestMatch = null;
            let bestMatchIndex = -1;
            let bestMatchScore = -1;
            
            // 모든 가능한 매칭을 확인하고 가장 정확한 매칭 선택
            for (let i = 0; i < constantWidthMap.length; i++) {
                const mapItem = constantWidthMap[i];
                
                if (mapItem.type === entity.type && mapItem.layer === entity.layer) {
                    let score = 0;
                    
                    // 첫 번째 정점으로 정확히 매칭 시도
                    if (entity.vertices && entity.vertices.length > 0) {
                        const entityFirstVertex = entity.vertices[0];
                        if (mapItem.firstVertex) {
                            const threshold = 0.001;
                            const xMatch = Math.abs(entityFirstVertex.x - mapItem.firstVertex.x) < threshold;
                            const yMatch = Math.abs(entityFirstVertex.y - mapItem.firstVertex.y) < threshold;
                            
                            if (xMatch && yMatch) {
                                // 정확히 매칭됨 - 최고 점수
                                score = 100;
                                bestMatch = mapItem;
                                bestMatchIndex = i;
                                bestMatchScore = score;
                                break; // 정확한 매칭을 찾았으므로 중단
                            }
                        }
                    }
                    
                    // 정점 매칭 실패 시, 순서 기반 점수 (가까운 인덱스일수록 높은 점수)
                    if (score === 0) {
                        score = 100 - Math.abs(i - mapIndex);
                        if (score > bestMatchScore) {
                            bestMatch = mapItem;
                            bestMatchIndex = i;
                            bestMatchScore = score;
                        }
                    }
                }
            }
            
            // 가장 좋은 매칭 적용
            if (bestMatch) {
                entity.constantWidth = bestMatch.constantWidth;
                foundCount++;
                matched = true;
                mapIndex = bestMatchIndex + 1;
            }
        });
    }
    
    fitDxfToView() {
        if (!this.dxfData) return;
        
        // DXF 경계 계산
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let validPointCount = 0;
        
        const isValidNumber = (n) => {
            return typeof n === 'number' && !isNaN(n) && isFinite(n);
        };
        
        const processEntity = (entity) => {
            try {
                // POLYLINE vertices
                if (entity.vertices && Array.isArray(entity.vertices)) {
                    entity.vertices.forEach(v => {
                        if (v && isValidNumber(v.x) && isValidNumber(v.y)) {
                            minX = Math.min(minX, v.x);
                            minY = Math.min(minY, v.y);
                            maxX = Math.max(maxX, v.x);
                            maxY = Math.max(maxY, v.y);
                            validPointCount++;
                        }
                    });
                }
                
                // LINE startPoint, endPoint
                if (entity.startPoint && isValidNumber(entity.startPoint.x) && isValidNumber(entity.startPoint.y)) {
                    minX = Math.min(minX, entity.startPoint.x);
                    minY = Math.min(minY, entity.startPoint.y);
                    maxX = Math.max(maxX, entity.startPoint.x);
                    maxY = Math.max(maxY, entity.startPoint.y);
                    validPointCount++;
                }
                if (entity.endPoint && isValidNumber(entity.endPoint.x) && isValidNumber(entity.endPoint.y)) {
                    minX = Math.min(minX, entity.endPoint.x);
                    minY = Math.min(minY, entity.endPoint.y);
                    maxX = Math.max(maxX, entity.endPoint.x);
                    maxY = Math.max(maxY, entity.endPoint.y);
                    validPointCount++;
                }
                
                // CIRCLE, ARC center + radius
                if (entity.center && isValidNumber(entity.center.x) && isValidNumber(entity.center.y)) {
                    const radius = isValidNumber(entity.radius) ? entity.radius : 0;
                    minX = Math.min(minX, entity.center.x - radius);
                    minY = Math.min(minY, entity.center.y - radius);
                    maxX = Math.max(maxX, entity.center.x + radius);
                    maxY = Math.max(maxY, entity.center.y + radius);
                    validPointCount++;
                }
                
                // POINT, TEXT, INSERT position
                if (entity.position && isValidNumber(entity.position.x) && isValidNumber(entity.position.y)) {
                    minX = Math.min(minX, entity.position.x);
                    minY = Math.min(minY, entity.position.y);
                    maxX = Math.max(maxX, entity.position.x);
                    maxY = Math.max(maxY, entity.position.y);
                    validPointCount++;
                }
                
                // SPLINE controlPoints
                if (entity.controlPoints && Array.isArray(entity.controlPoints)) {
                    entity.controlPoints.forEach(cp => {
                        if (cp && isValidNumber(cp.x) && isValidNumber(cp.y)) {
                            minX = Math.min(minX, cp.x);
                            minY = Math.min(minY, cp.y);
                            maxX = Math.max(maxX, cp.x);
                            maxY = Math.max(maxY, cp.y);
                            validPointCount++;
                        }
                    });
                }
                
                // SOLID, 3DFACE points
                if (entity.points && Array.isArray(entity.points)) {
                    entity.points.forEach(p => {
                        if (p && isValidNumber(p.x) && isValidNumber(p.y)) {
                            minX = Math.min(minX, p.x);
                            minY = Math.min(minY, p.y);
                            maxX = Math.max(maxX, p.x);
                            maxY = Math.max(maxY, p.y);
                            validPointCount++;
                        }
                    });
                }
            } catch (error) {
                console.warn('엔티티 경계 계산 오류:', error);
            }
        };
        
        if (this.dxfData.entities) {
            this.dxfData.entities.forEach(processEntity);
        }
        
        console.log(`경계 계산: 유효한 포인트 ${validPointCount}개`);
        console.log(`경계: minX=${minX}, maxX=${maxX}, minY=${minY}, maxY=${maxY}`);
        
        // 유효한 경계가 없는 경우
        if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minY) || !isFinite(maxY)) {
            console.warn('유효한 경계를 계산할 수 없습니다. 기본 뷰 사용.');
            this.viewBox = { x: -500, y: -500, width: 1000, height: 1000 };
            this.dxfBounds = null;
            this.dxfBoundsWGS84 = null;
            return;
        }
        
        // DXF 경계 저장 (EPSG:5186 좌표)
        this.dxfBounds = { minX, minY, maxX, maxY };
        
        // EPSG:5186을 WGS84로 변환
        this.convertDxfBoundsToWGS84();
        
        const dxfWidth = maxX - minX;
        const dxfHeight = maxY - minY;
        
        console.log(`도면 크기: ${dxfWidth} x ${dxfHeight}`);
        
        if (dxfWidth > 0 && dxfHeight > 0) {
            // 여백 추가 (10%)
            const margin = 0.1;
            const paddedWidth = dxfWidth * (1 + margin * 2);
            const paddedHeight = dxfHeight * (1 + margin * 2);
            
            // ViewBox 설정 (SVG는 Y축이 아래로 증가하므로 음수로)
            this.viewBox = {
                x: minX - dxfWidth * margin,
                y: -(maxY + dxfHeight * margin), // Y축 반전
                width: paddedWidth,
                height: paddedHeight
            };
            
            // 원본 ViewBox 저장 (확대율 계산용)
            this.originalViewBox = {...this.viewBox};
            
            console.log(`ViewBox 설정:`, this.viewBox);
        } else {
            console.warn('도면 크기가 0입니다. 기본 뷰 사용.');
            this.viewBox = { x: -500, y: -500, width: 1000, height: 1000 };
        }
    }
    
    drawWelcomeScreen() {
        // canvas 크기가 0이면 그리지 않음
        if (this.canvas.width === 0 || this.canvas.height === 0) {
            return;
        }
        
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
    }
    
    /**
     * ViewBox만 빠르게 업데이트 (드래그/줌 중)
     * 성능 최적화: Throttle 적용으로 ~60fps 제한, requestAnimationFrame 활용
     * 
     * 최적화 내용:
     * - Throttle 적용: 터치 이벤트가 매우 빈번해도 최대 60fps로 제한
     * - 중복 업데이트 방지: updatePending 플래그로 무한 루프 방지
     * - 지도 동기화 제외: 드래그/줌 중에는 지도 동기화 생략 (종료 시점에만 수행)
     * - 핀치줌 중 사진 그리기 최적화: 핀치줌 중에는 사진 그리기를 더 낮은 프레임레이트로 제한
     * 
     * @see updateViewBoxThrottled - Throttle 적용된 버전 사용
     */
    updateViewBox() {
        if (!this.dxfData) return;
        
        // 이미 예약된 업데이트가 있으면 중복 호출 방지
        if (this.updatePending) return;
        
        this.updatePending = true;
        
        // 핀치줌 중인지 확인
        const isPinching = this.touchState.isPinching;
        this.logTime(`updateViewBox 진입 (isPinching=${isPinching})`);
        
        // 핀치줌 중에는 ViewBox 업데이트를 더 제한적으로 (성능 최적화)
        if (isPinching) {
            // 핀치줌 중에는 ViewBox 업데이트를 더 낮은 프레임레이트로 제한 (약 30fps = 33ms)
            // 복잡한 DXF 렌더링 시 성능 개선
            if (!this._lastViewBoxUpdateTime || (Date.now() - this._lastViewBoxUpdateTime) >= 33) {
                requestAnimationFrame(() => {
                    this.updatePending = false;
                    this._lastViewBoxUpdateTime = Date.now();
                    
                    // SVG ViewBox만 업데이트 (SVG는 자동으로 재렌더링됨)
                    this.svg.setAttribute('viewBox', 
                        `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.width} ${this.viewBox.height}`);
                    
                    // 핀치줌 중에는 사진 그리기 완전 스킵 (성능 최적화)
                    // 핀치줌 종료 시 다시 그리기
                    this.logTime('updateViewBox (핀치) rAF 완료');
                });
            } else {
                // 너무 빈번한 업데이트는 스킵
                this.updatePending = false;
            }
        } else {
            // 일반 상태: 정상 업데이트
            requestAnimationFrame(() => {
                this.updatePending = false;
                
                // SVG ViewBox만 업데이트 (SVG는 자동으로 재렌더링됨)
                this.svg.setAttribute('viewBox', 
                    `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.width} ${this.viewBox.height}`);
                
                // Canvas 사진만 다시 그리기 (빠름)
                this.drawPhotosCanvas();
                
                // 지도 동기화는 드래그/줌 종료 시점에만 수행 (성능 최적화)
                this.logTime('updateViewBox (일반) rAF + drawPhotosCanvas 완료');
            });
        }
    }
    
    /**
     * 전체 다시 그리기 (DXF 로드, 사진 추가/삭제 시)
     * 성능 최적화: requestAnimationFrame으로 부드러운 렌더링, 중복 렌더링 방지
     * 
     * 최적화 내용:
     * - requestAnimationFrame으로 다음 프레임에 렌더링 (브라우저 최적화)
     * - redrawPending 플래그로 중복 호출 방지
     * - DXF SVG 렌더링 + Canvas 사진/텍스트 렌더링
     */
    redraw() {
        // requestAnimationFrame으로 부드러운 렌더링
        if (this.redrawPending) {
            this.debugLog('   ⏸️ redraw 이미 대기 중, 건너뜀');
            return;
        }
        
        this.redrawPending = true;
        this.debugLog('   ▶ redraw 예약됨 (requestAnimationFrame)');
        
        requestAnimationFrame(() => {
            this.redrawPending = false;
            this.debugLog('   🎨 redraw 실행 중...');
            
            if (!this.dxfData) {
                this.debugLog('      DXF 데이터 없음 - 환영 화면 표시');
                this.drawWelcomeScreen();
                this.clearCanvas();
                return;
            }
            
            // 1. SVG로 DXF 렌더링 (벡터)
            this.debugLog('      1️⃣ SVG DXF 그리기...');
            this.drawDxfSvg();
            
            // 2. Canvas로 사진 렌더링 (래스터)
            this.debugLog('      2️⃣ Canvas 사진/텍스트 그리기...');
            this.debugLog('         사진 개수:', this.photos.length);
            this.debugLog('         텍스트 개수:', this.texts.length);
            this.drawPhotosCanvas();
            
            this.debugLog('   ✅ redraw 완료');
        });
    }
    
    clearCanvas() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    
    
    drawDxfSvg() {
        this.logTime('drawDxfSvg 시작');
        // SVG 초기화
        while (this.svgGroup.firstChild) {
            this.svgGroup.removeChild(this.svgGroup.firstChild);
        }
        
        if (!this.dxfData || !this.dxfData.entities) return;
        
        // ViewBox 설정
        this.svg.setAttribute('viewBox', 
            `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.width} ${this.viewBox.height}`);
        
        this.debugLog('🖊️ SVG drawDxf() 시작, 엔티티:', this.dxfData.entities.length);
        
        let drawnCount = 0;
        let errorCount = 0;
        const fragment = document.createDocumentFragment();
        
        this.dxfData.entities.forEach((entity, index) => {
            try {
                if (!entity || !entity.type) {
                    console.warn(`엔티티 ${index}: 타입이 없습니다.`);
                    return;
                }
                
                const element = this.createSvgElement(entity);
                if (element) {
                    fragment.appendChild(element);
                    drawnCount++;
                }
            } catch (error) {
                errorCount++;
                if (errorCount <= 5) {
                    console.error(`엔티티 ${index} 렌더링 오류:`, error);
                }
            }
        });
        
        this.svgGroup.appendChild(fragment);
        this.debugLog(`SVG 렌더링 완료: ${drawnCount}개 성공, ${errorCount}개 실패`);
        this.logTime('drawDxfSvg 끝');
    }
    
    createSvgElement(entity) {
        // 엔티티 타입별로 SVG 요소 생성
        switch (entity.type) {
            case 'LINE':
                return this.createSvgLine(entity);
            case 'POLYLINE':
            case 'LWPOLYLINE':
                return this.createSvgPolyline(entity);
            case 'CIRCLE':
                return this.createSvgCircle(entity);
            case 'ARC':
                return this.createSvgArc(entity);
            case 'POINT':
                return this.createSvgPoint(entity);
            case 'TEXT':
            case 'MTEXT':
                return this.createSvgText(entity);
            case 'INSERT':
                return this.createSvgInsert(entity);
            case 'SPLINE':
                return this.createSvgSpline(entity);
            case 'ELLIPSE':
                return this.createSvgEllipse(entity);
            case 'SOLID':
            case '3DFACE':
                return this.createSvgSolid(entity);
            default:
                return null;
        }
    }
    
    createSvgLine(entity) {
        if (!entity.vertices || entity.vertices.length < 2) return null;
        
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', entity.vertices[0].x);
        line.setAttribute('y1', -entity.vertices[0].y); // Y축 반전
        line.setAttribute('x2', entity.vertices[1].x);
        line.setAttribute('y2', -entity.vertices[1].y);
        line.setAttribute('stroke', this.getEntityColor(entity)); // 실제 색상
        
        // 조건부 선 굵기: 실제 굵기가 0 초과면 2px, 아니면 0.5px
        // ⭐ lineweight가 undefined인 경우 처리 개선
        const lineweight = (entity.lineweight !== undefined && entity.lineweight !== null && entity.lineweight >= 0) 
            ? entity.lineweight 
            : (entity.lineweight === undefined || entity.lineweight === null ? -1 : 0);
        const constantWidth = (entity.constantWidth !== undefined && entity.constantWidth !== null) 
            ? entity.constantWidth 
            : 0;
        const actualWidth = Math.max(lineweight >= 0 ? lineweight : 0, constantWidth);
        const strokeWidth = (actualWidth > 0) ? 2 : 0.5;
        
        // 디버그용 데이터 속성 추가
        line.setAttribute('data-lineweight', entity.lineweight);
        line.setAttribute('data-constantwidth', entity.constantWidth || 0);
        line.setAttribute('data-actualwidth', actualWidth);
        line.setAttribute('data-strokewidth', strokeWidth);
        line.setAttribute('data-layer', entity.layer || '');
        
        line.setAttribute('style', `stroke-width: ${strokeWidth}px; vector-effect: non-scaling-stroke;`);
        
        line.setAttribute('stroke-linecap', 'round');
        
        return line;
    }
    
    createSvgPolyline(entity) {
        if (!entity.vertices || entity.vertices.length < 2) return null;
        
        const validVertices = entity.vertices.filter(v => 
            v && typeof v.x === 'number' && typeof v.y === 'number'
        );
        
        if (validVertices.length < 2) return null;
        
        // ⭐ closed 속성 확인
        const isClosed = entity.closed || entity.shape;
        
        // ⭐ 중복 정점 제거: 마지막 점이 첫 점과 같으면 제거 (polygon은 자동으로 닫힘)
        let finalVertices = [...validVertices];
        if (isClosed && validVertices.length > 2) {
            const first = validVertices[0];
            const last = validVertices[validVertices.length - 1];
            const threshold = 0.0001; // 매우 작은 값
            if (Math.abs(first.x - last.x) < threshold && Math.abs(first.y - last.y) < threshold) {
                finalVertices = validVertices.slice(0, -1); // 마지막 점 제거
            }
        }
        
        const points = finalVertices.map(v => `${v.x},${-v.y}`).join(' ');
        
        const element = document.createElementNS('http://www.w3.org/2000/svg', isClosed ? 'polygon' : 'polyline');
        
        element.setAttribute('points', points);
        element.setAttribute('fill', 'none');
        element.setAttribute('stroke', this.getEntityColor(entity)); // 실제 색상
        
        // 조건부 선 굵기: 실제 굵기가 0 초과면 2px, 아니면 0.5px
        // ⭐ lineweight가 undefined인 경우 처리 개선
        const lineweight = (entity.lineweight !== undefined && entity.lineweight !== null && entity.lineweight >= 0) 
            ? entity.lineweight 
            : (entity.lineweight === undefined || entity.lineweight === null ? -1 : 0);
        const constantWidth = (entity.constantWidth !== undefined && entity.constantWidth !== null) 
            ? entity.constantWidth 
            : 0;
        const actualWidth = Math.max(lineweight >= 0 ? lineweight : 0, constantWidth);
        const strokeWidth = (actualWidth > 0) ? 2 : 0.5;
        
        // 디버그용 데이터 속성 추가
        element.setAttribute('data-lineweight', entity.lineweight);
        element.setAttribute('data-constantwidth', entity.constantWidth || 0);
        element.setAttribute('data-actualwidth', actualWidth);
        element.setAttribute('data-strokewidth', strokeWidth);
        element.setAttribute('data-layer', entity.layer || '');
        
        element.setAttribute('style', `stroke-width: ${strokeWidth}px; vector-effect: non-scaling-stroke;`);
        
        element.setAttribute('stroke-linejoin', 'round');
        element.setAttribute('stroke-linecap', 'round');
        
        return element;
    }
    
    createSvgCircle(entity) {
        if (!entity.center || !entity.radius) return null;
        
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', entity.center.x);
        circle.setAttribute('cy', -entity.center.y);
        circle.setAttribute('r', entity.radius);
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', this.getEntityColor(entity)); // 실제 색상
        
        // 조건부 선 굵기: 실제 굵기가 0 초과면 2px, 아니면 0.5px
        const lineweight = (entity.lineweight >= 0) ? entity.lineweight : 0;
        const constantWidth = entity.constantWidth || 0;
        const actualWidth = Math.max(lineweight, constantWidth);
        const strokeWidth = (actualWidth > 0) ? 2 : 0.5;
        circle.setAttribute('style', `stroke-width: ${strokeWidth}; vector-effect: non-scaling-stroke;`);
        
        return circle;
    }
    
    createSvgArc(entity) {
        if (!entity.center || !entity.radius) return null;
        
        // Arc를 path로 변환
        const startAngle = entity.startAngle || 0;
        const endAngle = entity.endAngle || 0;
        
        const startX = entity.center.x + entity.radius * Math.cos(startAngle);
        const startY = entity.center.y + entity.radius * Math.sin(startAngle);
        const endX = entity.center.x + entity.radius * Math.cos(endAngle);
        const endY = entity.center.y + entity.radius * Math.sin(endAngle);
        
        const largeArc = (endAngle - startAngle) > Math.PI ? 1 : 0;
        
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const d = `M ${startX} ${-startY} A ${entity.radius} ${entity.radius} 0 ${largeArc} 1 ${endX} ${-endY}`;
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', this.getEntityColor(entity)); // 실제 색상
        
        // 조건부 선 굵기: 실제 굵기가 0 초과면 2px, 아니면 0.5px
        const lineweight = (entity.lineweight >= 0) ? entity.lineweight : 0;
        const constantWidth = entity.constantWidth || 0;
        const actualWidth = Math.max(lineweight, constantWidth);
        const strokeWidth = (actualWidth > 0) ? 2 : 0.5;
        path.setAttribute('style', `stroke-width: ${strokeWidth}; vector-effect: non-scaling-stroke;`);
        
        return path;
    }
    
    createSvgPoint(entity) {
        if (!entity.position) return null;
        
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', entity.position.x);
        circle.setAttribute('cy', -entity.position.y);
        circle.setAttribute('r', '0.03'); // 매우 작게 (기존 크기의 20%)
        circle.setAttribute('fill', '#00FF00'); // 초록색 고정
        circle.setAttribute('class', 'dxf-point'); // CSS 클래스
        
        return circle;
    }
    
    createSvgText(entity) {
        if (!entity.text) return null;
        const pos = entity.startPoint || entity.position;
        if (!pos) return null;
        
        const fontSize = entity.textHeight || entity.height || 10;
        
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('fill', this.getEntityColor(entity)); // 실제 색상
        text.setAttribute('font-family', 'Arial, sans-serif');
        text.setAttribute('font-size', fontSize);
        text.textContent = entity.text;
        
        // ⭐ 수평 정렬 처리 (halign: 0=왼쪽, 1=중앙, 2=오른쪽, 3=정렬, 4=중간, 5=맞춤)
        const halign = entity.halign || 0;
        if (halign === 1 || halign === 4) {
            text.setAttribute('text-anchor', 'middle');
        } else if (halign === 2) {
            text.setAttribute('text-anchor', 'end');
        } else {
            text.setAttribute('text-anchor', 'start');
        }
        
        // ⭐ 수직 정렬 처리 (valign: 0=기준선, 1=아래, 2=중앙, 3=위)
        const valign = entity.valign || 0;
        if (valign === 1) {
            text.setAttribute('dominant-baseline', 'text-after-edge');
        } else if (valign === 2) {
            text.setAttribute('dominant-baseline', 'middle');
        } else if (valign === 3) {
            text.setAttribute('dominant-baseline', 'text-before-edge');
        } else {
            text.setAttribute('dominant-baseline', 'alphabetic');
        }
        
        // SVG는 Y축이 아래로 증가하므로 텍스트 변환 처리
        if (entity.rotation) {
            // 회전이 있는 경우
            const rotationDeg = -entity.rotation * 180 / Math.PI; // 라디안을 각도로, 반전
            text.setAttribute('transform', 
                `translate(${pos.x}, ${-pos.y}) rotate(${rotationDeg})`);
            text.setAttribute('x', 0);
            text.setAttribute('y', 0);
        } else {
            // 회전이 없는 경우
            text.setAttribute('x', pos.x);
            text.setAttribute('y', -pos.y);
        }
        
        // 디버그: 텍스트 정보 (처음 3개만)
        if (!this._textDebugCount) this._textDebugCount = 0;
        if (this._textDebugCount < 3) {
            console.log(`📝 텍스트 "${entity.text}": pos=(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}), rotation=${entity.rotation ? (entity.rotation * 180 / Math.PI).toFixed(1) : 0}°`);
            console.log(`   halign=${halign}, valign=${valign}, fontSize=${fontSize}`);
            this._textDebugCount++;
        }
        
        return text;
    }
    
    createSvgInsert(entity) {
        if (!entity.position || !entity.name) return null;
        
        const block = this.dxfData.blocks && this.dxfData.blocks[entity.name];
        
        if (!block || !block.entities || block.entities.length === 0) {
            return this.createSvgInsertFallback(entity);
        }
        
        // 블록 그룹 생성
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        
        // ⭐ 변환 적용 (SVG transform 순서 주의)
        const transforms = [];
        
        // 1. 삽입 위치로 이동
        transforms.push(`translate(${entity.position.x}, ${-entity.position.y})`);
        
        // 2. 회전 적용 (라디안 → 각도 변환)
        if (entity.rotation) {
            const rotationDeg = -(entity.rotation * 180 / Math.PI);
            transforms.push(`rotate(${rotationDeg})`);
        }
        
        // 3. Scale 적용 (X만 적용, Y는 반전하지 않음)
        const xScale = entity.xScale || 1;
        const yScale = entity.yScale || 1;
        if (xScale !== 1 || yScale !== 1) {
            transforms.push(`scale(${xScale}, ${yScale})`); // ⭐ Y축 그대로 사용
        }
        
        // 4. 블록 기준점 보정
        if (block.position) {
            transforms.push(`translate(${-block.position.x}, ${block.position.y})`);
        }
        
        // transform 속성 설정
        const transformStr = transforms.join(' ');
        group.setAttribute('transform', transformStr);
        
        // 디버그: 블록 변환 정보 (처음 3개만)
        if (!this._blockDebugCount) this._blockDebugCount = 0;
        if (this._blockDebugCount < 3) {
            console.log(`📦 블록 "${entity.name}": pos=(${entity.position.x.toFixed(1)}, ${entity.position.y.toFixed(1)}), rotation=${entity.rotation ? (entity.rotation * 180 / Math.PI).toFixed(1) : 0}°, scale=(${xScale}, ${yScale})`);
            console.log(`   → transform="${transformStr}"`);
            
            // 블록 내부 엔티티 타입 확인
            const entityTypes = block.entities.map(e => e.type).join(', ');
            console.log(`   → 내부 엔티티: ${entityTypes}`);
            this._blockDebugCount++;
        }
        
        // 블록 내부 엔티티 렌더링
        block.entities.forEach(blockEntity => {
            const element = this.createSvgElement(blockEntity);
            if (element) {
                group.appendChild(element);
            }
        });
        
        return group;
    }
    
    createSvgInsertFallback(entity) {
        // 블록을 찾을 수 없을 때
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        
        const size = 5;
        
        // 십자 표시
        const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line1.setAttribute('x1', entity.position.x - size);
        line1.setAttribute('y1', -entity.position.y);
        line1.setAttribute('x2', entity.position.x + size);
        line1.setAttribute('y2', -entity.position.y);
        line1.setAttribute('stroke', '#FF6600');
        line1.setAttribute('stroke-width', '0.5'); // 얇게
        line1.setAttribute('vector-effect', 'non-scaling-stroke');
        
        const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line2.setAttribute('x1', entity.position.x);
        line2.setAttribute('y1', -entity.position.y - size);
        line2.setAttribute('x2', entity.position.x);
        line2.setAttribute('y2', -entity.position.y + size);
        line2.setAttribute('stroke', '#FF6600');
        line2.setAttribute('stroke-width', '0.5'); // 얇게
        line2.setAttribute('vector-effect', 'non-scaling-stroke');
        
        group.appendChild(line1);
        group.appendChild(line2);
        
        return group;
    }
    
    createSvgSpline(entity) {
        if (!entity.controlPoints || entity.controlPoints.length < 2) return null;
        
        const points = entity.controlPoints
            .filter(cp => cp && typeof cp.x === 'number' && typeof cp.y === 'number')
            .map(cp => `${cp.x},${-cp.y}`)
            .join(' ');
        
        const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        polyline.setAttribute('points', points);
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', this.getEntityColor(entity)); // 실제 색상
        
        // 조건부 선 굵기: 실제 굵기가 0 초과면 2px, 아니면 0.5px
        const lineweight = (entity.lineweight >= 0) ? entity.lineweight : 0;
        const constantWidth = entity.constantWidth || 0;
        const actualWidth = Math.max(lineweight, constantWidth);
        const strokeWidth = (actualWidth > 0) ? 2 : 0.5;
        polyline.setAttribute('style', `stroke-width: ${strokeWidth}; vector-effect: non-scaling-stroke;`);
        
        return polyline;
    }
    
    createSvgEllipse(entity) {
        if (!entity.center || !entity.majorAxisEndPoint) return null;
        
        const cx = entity.center.x;
        const cy = -entity.center.y;
        const rx = Math.sqrt(
            Math.pow(entity.majorAxisEndPoint.x, 2) + 
            Math.pow(entity.majorAxisEndPoint.y, 2)
        );
        const ry = rx * (entity.axisRatio || 1);
        
        const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        ellipse.setAttribute('cx', cx);
        ellipse.setAttribute('cy', cy);
        ellipse.setAttribute('rx', rx);
        ellipse.setAttribute('ry', ry);
        ellipse.setAttribute('fill', 'none');
        ellipse.setAttribute('stroke', this.getEntityColor(entity)); // 실제 색상
        
        // 조건부 선 굵기: 실제 굵기가 0 초과면 2px, 아니면 0.5px
        const lineweight = (entity.lineweight >= 0) ? entity.lineweight : 0;
        const constantWidth = entity.constantWidth || 0;
        const actualWidth = Math.max(lineweight, constantWidth);
        const strokeWidth = (actualWidth > 0) ? 2 : 0.5;
        ellipse.setAttribute('style', `stroke-width: ${strokeWidth}; vector-effect: non-scaling-stroke;`);
        
        return ellipse;
    }
    
    createSvgSolid(entity) {
        if (!entity.points || entity.points.length < 3) return null;
        
        const points = entity.points
            .filter(p => p && typeof p.x === 'number' && typeof p.y === 'number')
            .map(p => `${p.x},${-p.y}`)
            .join(' ');
        
        const color = this.getEntityColor(entity);
        
        const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        polygon.setAttribute('points', points);
        polygon.setAttribute('fill', color + '40'); // 25% 투명도
        polygon.setAttribute('stroke', color); // 실제 색상
        // stroke-width는 CSS에서 처리
        
        return polygon;
    }
    
    drawPhotosCanvas() {
        this.logTime('drawPhotosCanvas 시작');
        this.debugLog('         🖼️ drawPhotosCanvas 시작');
        // Canvas 초기화 (투명) - 한 번에 처리
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.debugLog('            Canvas 초기화 완료 (크기:', this.canvas.width, 'x', this.canvas.height, ')');
        
        // 사진과 텍스트가 없으면 빠르게 리턴
        if (this.photos.length === 0 && this.texts.length === 0) {
            this.debugLog('            사진/텍스트 없음 - 건너뜀');
            this.logTime('drawPhotosCanvas 종료 (사진/텍스트 없음)');
            return;
        }
        
        // 사진 마커 그리기
        this.debugLog('            사진 그리기 시작 (' + this.photos.length + '개)');
        this.drawPhotos();
        
        // 텍스트 그리기
        this.debugLog('            텍스트 그리기 시작 (' + this.texts.length + '개)');
        this.drawTexts();
        
        this.debugLog('         ✅ drawPhotosCanvas 완료');
        this.logTime('drawPhotosCanvas 종료');
    }
    
    /**
     * 텍스트 그리기 (최적화: rect 캐싱, 화면 밖 요소 필터링)
     */
    drawTexts() {
        const rect = this.getCachedRect();
        const margin = 50; // 여유 공간 (텍스트 크기 고려)
        
        // ViewBox 기반 필터링으로 화면에 보이는 텍스트만 선택
        const visibleTexts = this.texts.filter(textObj => {
            // ViewBox 좌표 → 스크린 좌표 변환
            const { x, y } = this.viewToCanvasCoords(textObj.x, textObj.y);
            
            // 화면 밖에 있는지 확인 (여유 공간 포함)
            return x >= -margin && 
                   x <= rect.width + margin && 
                   y >= -margin && 
                   y <= rect.height + margin;
        });
        
        this.debugLog('               📝 drawTexts 실행 - 전체:', this.texts.length, '개, 화면 내:', visibleTexts.length, '개');
        
        // 화면에 보이는 텍스트만 렌더링
        visibleTexts.forEach(textObj => {
            // ViewBox 좌표 → 스크린 좌표 변환 (필터링된 텍스트이므로 이미 화면 내)
            const { x, y } = this.viewToCanvasCoords(textObj.x, textObj.y);
            
            // 고정 크기: 9px (작은 크기, 줌과 무관하게 일정)
            const fontSize = 9;
            
            this.ctx.save();
            
            // 텍스트 스타일
            this.ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
            this.ctx.fillStyle = '#FF3B30'; // 빨간색 (잘 보이게)
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            
            // 텍스트 배경 제거 (투명)
            // const textWidth = this.ctx.measureText(textObj.text).width;
            // const padding = 5;
            // this.ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            // this.ctx.fillRect(x - textWidth / 2 - padding, y - fontSize / 2 - padding, 
            //                  textWidth + padding * 2, fontSize + padding * 2);
            
            // 텍스트 그리기 (배경 없이)
            this.ctx.fillStyle = '#FF3B30';
            this.ctx.fillText(textObj.text, x, y);
            
            this.ctx.restore();
        });
    }
    
    // 기존 Canvas 렌더링 함수들은 제거됨 (SVG로 대체)
    
    /**
     * 사진을 작은 점(●)으로 표시
     * 성능 최적화: 화면 밖 사진은 미리 필터링하여 불필요한 렌더링 제거
     * 
     * 최적화 내용:
     * - ViewBox 기반 필터링으로 화면에 보이는 사진만 선택
     * - 많은 사진이 있어도 화면 내 사진만 렌더링하여 성능 향상
     * - 사진 100개 이상일 때 렌더링 속도 약 50% 개선
     * 
     * 표시 방식:
     * - 업로드 완료: 빨간색/보라색 작은 점 (3.75px 반지름)
     * - 업로드 대기: 초록색 큰 점 (18.75px 반지름) - 주의 필요
     */
    drawPhotos() {
        const rect = this.getCachedRect();
        const margin = 50; // 여유 공간 (마커 크기 고려)
        
        // ViewBox 기반 필터링으로 화면에 보이는 사진만 선택
        const visiblePhotos = this.photos.filter(photo => {
            // ViewBox 좌표 → 스크린 좌표 변환
            const { x: screenX, y: screenY } = this.viewToCanvasCoords(photo.x, photo.y);
            
            // 화면 밖에 있는지 확인 (여유 공간 포함)
            return screenX >= -margin && 
                   screenX <= rect.width + margin && 
                   screenY >= -margin && 
                   screenY <= rect.height + margin;
        });
        
        this.debugLog('               📷 drawPhotos 실행 - 전체:', this.photos.length, '개, 화면 내:', visiblePhotos.length, '개');
        
        // 화면에 보이는 사진만 렌더링
        visiblePhotos.forEach((photo, index) => {
            // ViewBox 좌표 → 스크린 좌표 변환 (필터링된 사진이므로 이미 화면 내)
            const { x: screenX, y: screenY } = this.viewToCanvasCoords(photo.x, photo.y);
            
            this.ctx.save();
            
            // 업로드 상태에 따른 색상 및 크기 결정
            const isUploaded = photo.uploaded === true;
            const hasMemo = photo.memo && photo.memo.trim();
            
            let markerColor;
            let markerRadius;
            
            if (isUploaded) {
                // 업로드 완료 → 빨간점 (작은 크기)
                markerColor = hasMemo ? '#9B51E0' : '#FF0000'; // 보라색(메모) 또는 빨간색
                markerRadius = 5.625; // 직경 11.25px (기존 1.5배)
            } else {
                // 업로드 실패/대기 → 초록색 (5배 크기) - 사용자 알림
                markerColor = '#00C853'; // 초록색 (주의 필요)
                markerRadius = 18.75; // 직경 37.5px (5배 크기)
            }
            
            // 원 그리기
            this.ctx.fillStyle = markerColor;
            this.ctx.beginPath();
            this.ctx.arc(screenX, screenY, markerRadius, 0, Math.PI * 2);
            this.ctx.fill();
            
            // 테두리 (흰색, 더 잘 보이게)
            this.ctx.strokeStyle = '#FFFFFF';
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
            
            this.ctx.restore();
        });
        
        this.debugLog('               ✅ drawPhotos 완료 - 총', this.photos.length, '개 그림');
    }
    
    /**
     * 특정 위치에 사진 추가
     * @param {File} file - 이미지 파일
     * @param {Object} position - {x, y} ViewBox 좌표
     */
    async addPhotoAt(file, position, locationInfo = null) {
        this.debugLog('====================================');
        this.debugLog('📷 addPhotoAt 호출됨');
        this.debugLog('   파일:', file);
        this.debugLog('   파일명:', file?.name);
        this.debugLog('   파일 크기:', file?.size, 'bytes');
        this.debugLog('   위치:', position);
        this.debugLog('   위치 정보:', locationInfo);
        this.debugLog('====================================');
        
        if (!file) {
            console.warn('⚠️ 파일이 없습니다');
            this.showToast('⚠️ 파일이 선택되지 않았습니다');
            return;
        }
        
        if (!position) {
            console.error('❌ 위치 정보가 없습니다');
            this.showToast('⚠️ 위치 정보가 없습니다');
            return;
        }
        
        if (typeof position.x !== 'number' || typeof position.y !== 'number') {
            console.error('❌ 위치 좌표가 올바르지 않습니다:', position);
            this.showToast('⚠️ 위치 좌표가 올바르지 않습니다');
            return;
        }
        
        this.debugLog('▶ 사진 추가 프로세스 시작:', file.name);
        this.debugLog('   위치:', { x: position.x, y: position.y });
        try {
            // 이미지 로드
            this.debugLog('1️⃣ 이미지 데이터 읽기 시작...');
            const imageData = await this.readFileAsDataURL(file);
            this.debugLog('   ✓ 이미지 데이터 읽기 완료 (길이:', imageData?.length, ')');
            
            this.debugLog('2️⃣ 이미지 객체 생성 시작...');
            const image = await this.loadImage(imageData);
            this.debugLog('   ✓ 이미지 로드 완료 (크기:', image.width, 'x', image.height, ')');
            
            // 이미지 압축 (설정된 용량에 따라)
            this.debugLog('3️⃣ 이미지 압축 시작...');
            const targetSize = this.getImageTargetSize();
            this.debugLog('   목표 용량:', targetSize === null ? '원본' : `${(targetSize / 1024).toFixed(0)}KB`);
            
            // 변환 중 메시지 (목표 용량 표시) - 로딩 인디케이터 대신 토스트 메시지 사용
            if (targetSize === null) {
                this.showToast('🔄 변환 중 (원본)');
            } else {
                const targetSizeKB = (targetSize / 1024).toFixed(0);
                this.showToast(`🔄 변환 중 (${targetSizeKB}KB)`);
            }
            
            let compressedImageData;
            if (targetSize === null) {
                // 원본: 압축 없이 Base64만 변환
                compressedImageData = imageData;
                this.debugLog('   ✓ 원본 사용 (압축 없음, 크기:', (compressedImageData.length / 1024).toFixed(2), 'KB)');
            } else {
                compressedImageData = await this.compressImage(image, file.name, targetSize);
                
                // 압축된 데이터 유효성 검증
                if (!compressedImageData || compressedImageData.length === 0) {
                    throw new Error('이미지 압축 실패: 압축된 데이터가 비어있습니다');
                }
                
                // Data URL 형식 검증
                if (!compressedImageData.startsWith('data:image/')) {
                    throw new Error('이미지 압축 실패: 잘못된 데이터 형식입니다');
                }
                
                this.debugLog('   ✓ 이미지 압축 완료 (압축 크기:', (compressedImageData.length / 1024).toFixed(2), 'KB)');
            }
            
            // 변환 완료 토스트 (대기 시간 제거 - 속도 최적화)
            this.showToast('✅ 변환 완료');
            
            // 사진 객체 생성
            // x, y: ViewBox 좌표계에 고정 (롱프레스한 위치)
            // width, height: 화면 표시용이 아닌 메타데이터 용도 (항상 고정값)
            const photo = {
                id: Date.now(),
                x: position.x,  // ViewBox 좌표 (고정)
                y: position.y,  // ViewBox 좌표 (고정)
                width: 1,       // 더미값 (화면 표시는 픽셀 기준 25px 고정)
                height: 1,      // 더미값 (화면 표시는 픽셀 기준 25px 고정)
                imageData: compressedImageData, // 압축된 이미지 사용
                image: image,
                memo: '',
                fileName: null,
                uploaded: false // 업로드 상태 추적
            };
            
            this.debugLog('4️⃣ 사진 객체 생성 완료:', {
                id: photo.id,
                x: photo.x,
                y: photo.y,
                width: photo.width,
                height: photo.height,
                fileName: photo.fileName
            });
            
            this.photos.push(photo);
            this.metadataDirty = true;
            this.debugLog(`5️⃣ 사진 배열에 추가됨 (총 ${this.photos.length}개)`);
            this.debugLog('   현재 사진 목록:', this.photos.map(p => ({ id: p.id, fileName: p.fileName })));
            
            this.debugLog('6️⃣ 화면 다시 그리기 시작...');
            this.redraw();
            this.debugLog('   ✓ 화면 다시 그리기 완료');
            
            // Google Drive 자동 저장 (비동기로 실행 - 저장 완료를 기다리지 않음)
            // 사용자가 저장 완료를 기다리지 않고 연속으로 사진을 촬영할 수 있도록
            this.debugLog('7️⃣ 자동 저장 시작 (비동기)...');
            this.showToast('☁️ 저장 중 (구글드라이브)');
            
            // 비동기로 저장 실행 (await 제거)
            this.autoSave(true).catch(error => {
                console.error('❌ 자동 저장 오류 (비동기):', error);
                // 오류 발생 시에도 사용자 작업은 계속 가능하도록
            });
            
            // 동일 좌표에 추가된 경우 모달 다시 열기
            if (locationInfo && this.currentPhotoGroup.length > 0) {
                this.debugLog('8️⃣ 동일 좌표 추가 감지, 모달 다시 열기...');
                await this.openPhotoViewModal(photo.id);
            }
            
        } catch (error) {
            console.error('❌❌❌ 사진 추가 오류 ❌❌❌');
            console.error('오류 내용:', error);
            console.error('오류 스택:', error.stack);
            this.showToast(`❌ 사진 추가 실패: ${error.message}`);
            throw error; // 에러를 다시 던져서 상위에서도 처리할 수 있게 함
        }
    }
    
    async addPhoto(file) {
        if (!file) return;
        
        // ViewBox 중앙 계산
        const viewCenterX = this.viewBox.x + this.viewBox.width / 2;
        const viewCenterY = this.viewBox.y + this.viewBox.height / 2;
        
        await this.addPhotoAt(file, { x: viewCenterX, y: viewCenterY });
    }
    
    readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            this.debugLog('   📖 FileReader 시작...');
            const reader = new FileReader();
            reader.onload = (e) => {
                this.debugLog('   ✓ FileReader 완료');
                resolve(e.target.result);
            };
            reader.onerror = (error) => {
                console.error('   ❌ FileReader 오류:', error);
                reject(new Error('파일 읽기 실패: ' + error));
            };
            reader.readAsDataURL(file);
        });
    }
    
    loadImage(src) {
        return new Promise((resolve, reject) => {
            this.debugLog('   🖼️ Image 객체 생성...');
            const img = new Image();
            img.onload = () => {
                this.debugLog('   ✓ Image 로드 성공:', img.width, 'x', img.height);
                resolve(img);
            };
            img.onerror = (error) => {
                console.error('   ❌ Image 로드 오류:', error);
                reject(new Error('이미지 로드 실패'));
            };
            img.src = src;
        });
    }
    
    /**
     * 이미지 압축 (목표 용량에 따라 최적화)
     * 참조: 사진변환_참조.html의 compressImageTo100KB 함수 기반
     * @param {Image} image - 원본 이미지 객체
     * @param {string} fileName - 파일 이름
     * @param {number} targetSize - 목표 크기 (bytes)
     * @returns {Promise<string>} 압축된 이미지 Data URL
     */
    async compressImage(image, fileName, targetSize) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        try {
            // 목표 용량에 따라 초기 리사이즈 크기 결정 (압축 반복 감소)
            // 작은 목표 용량일수록 더 작게 리사이즈하여 품질 조절 반복을 줄임
            let maxDimension;
            if (targetSize <= 500 * 1024) {
                // 500KB 이하: 800px (더 작게 리사이즈하여 압축 반복 감소)
                maxDimension = 800;
            } else if (targetSize <= 1024 * 1024) {
                // 1MB 이하: 1200px (기존 크기)
                maxDimension = 1200;
            } else if (targetSize <= 2 * 1024 * 1024) {
                // 2MB 이하: 1600px (더 큰 크기 허용)
                maxDimension = 1600;
            } else {
                // 2MB 초과: 2000px (매우 큰 크기 허용)
                maxDimension = 2000;
            }
            
            let width = image.width;
            let height = image.height;
            
            // 비율 유지하며 축소
            if (width > maxDimension || height > maxDimension) {
                if (width > height) {
                    height = Math.floor((height / width) * maxDimension);
                    width = maxDimension;
                } else {
                    width = Math.floor((width / height) * maxDimension);
                    height = maxDimension;
                }
            }
            
            canvas.width = width;
            canvas.height = height;
            
            this.debugLog('   압축 캔버스 크기:', width, 'x', height);
            
            // 이미지 그리기
            ctx.drawImage(image, 0, 0, width, height);
            
            // 목표 용량에 맞는 품질을 더 정확하게 추정
            // 개선된 공식: 더 정확한 품질 예측 (제안 사항 반영)
            const pixelCount = width * height;
            const targetBytes = targetSize;
            
            // 실제 Blob 크기를 정확히 측정하기 위한 헬퍼 함수
            // Base64 DataURL을 Blob으로 변환하여 정확한 바이너리 크기 측정
            const getActualBlobSize = async (dataUrl) => {
                try {
                    const response = await fetch(dataUrl);
                    const blob = await response.blob();
                    return blob.size; // 실제 바이너리 크기
                } catch (error) {
                    // 오류 시 근사치 사용 (Base64 변환)
                    const dataUrlPrefixLength = 23;
                    const base64Length = Math.max(0, dataUrl.length - dataUrlPrefixLength);
                    return Math.floor(base64Length * 0.75);
                }
            };
            
            // 품질 추정 공식 개선 - 2.5배 효과 반영
            // 실제 저장되는 크기가 목표의 약 40%이므로, 목표 용량을 2.5배로 상향 조정하여 추정
            const adjustedTargetSize = targetSize * 2.5; // 2.5배 상향 조정
            
            // 품질 추정 공식 (계수 0.25 사용 - 더 높은 품질로 추정)
            let estimatedQuality = Math.pow(adjustedTargetSize / (pixelCount * 0.25), 1/1.6);
            estimatedQuality = Math.max(0.4, Math.min(0.95, estimatedQuality)); // 0.4 ~ 0.95 범위
            
            // 목표 용량에 따른 추가 조정 (2.5배 효과 보완)
            if (targetSize <= 500 * 1024) {
                estimatedQuality *= 1.2; // 500KB는 품질을 더 높임
            } else if (targetSize <= 1024 * 1024) {
                estimatedQuality *= 1.15; // 1MB는 품질을 높임
            } else {
                estimatedQuality *= 1.1; // 2MB 이상은 품질을 약간 높임
            }
            estimatedQuality = Math.max(0.4, Math.min(0.95, estimatedQuality));
            
            this.debugLog(`   추정 품질: ${estimatedQuality.toFixed(2)} (목표: ${(targetSize / 1024).toFixed(0)}KB, 조정된 목표: ${(adjustedTargetSize / 1024).toFixed(0)}KB)`);
            
            // 첫 압축 - 실제 Blob 크기로 정확히 측정
            let quality = estimatedQuality;
            let compressedData = canvas.toDataURL('image/jpeg', quality);
            let compressedSize = await getActualBlobSize(compressedData); // 실제 Blob 크기 측정
            
            this.debugLog(`   첫 압축 (품질 ${quality.toFixed(2)}): ${(compressedSize / 1024).toFixed(2)}KB (목표: ${(targetSize / 1024).toFixed(0)}KB)`);
            
            // 이진 탐색 방식으로 품질 조정 (최대 2번 반복으로 속도 최적화)
            const tolerance = 0.12; // 목표 크기의 12% 오차 허용 (속도와 정확도 균형)
            let minQuality = 0.3;
            let maxQuality = 0.95;
            let iterations = 0;
            const maxIterations = 2; // 최대 2번 반복 (속도 최적화)
            
            while (iterations < maxIterations) {
                const diff = compressedSize - targetSize;
                const diffRatio = Math.abs(diff) / targetSize;
                
                // 목표 범위 내에 있으면 종료
                if (diffRatio <= tolerance) {
                    break;
                }
                
                iterations++;
                
                if (compressedSize > targetSize) {
                    // 목표보다 크면 품질 낮춤
                    maxQuality = quality;
                    quality = (minQuality + quality) / 2;
                } else {
                    // 목표보다 작으면 품질 높임
                    minQuality = quality;
                    quality = (quality + maxQuality) / 2;
                }
                
                quality = Math.max(0.3, Math.min(0.95, quality));
                compressedData = canvas.toDataURL('image/jpeg', quality);
                compressedSize = await getActualBlobSize(compressedData); // 실제 Blob 크기 측정
                
                this.debugLog(`   조정 ${iterations} (품질 ${quality.toFixed(2)}): ${(compressedSize / 1024).toFixed(2)}KB`);
            }
            
            // 여전히 목표보다 작으면 이미지 크기를 추가로 확대 (목표 용량 달성을 위해)
            if (compressedSize < targetSize * 0.7) {
                this.debugLog('   ⚠️ 품질 조정만으로 부족 - 이미지 크기 추가 확대');
                // 목표 크기에 맞추기 위해 정확한 비율 계산
                const scaleFactor = Math.sqrt(targetSize / compressedSize) * 1.05;
                width = Math.floor(width * scaleFactor);
                height = Math.floor(height * scaleFactor);
                canvas.width = width;
                canvas.height = height;
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(image, 0, 0, width, height);
                
                // 확대 후 품질 재추정 (2.5배 효과 반영)
                const newPixelCount = width * height;
                const newAdjustedTargetSize = targetSize * 2.5;
                quality = Math.pow(newAdjustedTargetSize / (newPixelCount * 0.25), 1/1.6);
                quality = Math.max(0.4, Math.min(0.9, quality));
                compressedData = canvas.toDataURL('image/jpeg', quality);
                compressedSize = await getActualBlobSize(compressedData);
                this.debugLog(`   크기 확대 후 압축 (품질 ${quality.toFixed(2)}): ${(compressedSize / 1024).toFixed(2)}KB`);
            }
            
            // 최종 크기 확인 (실제 Blob 크기)
            const finalSizeKB = (compressedSize / 1024).toFixed(2);
            const targetSizeKB = (targetSize / 1024).toFixed(2);
            const diffRatio = Math.abs(compressedSize - targetSize) / targetSize;
            const accuracy = ((1 - diffRatio) * 100).toFixed(1);
            this.debugLog(`   ✅ 최종 압축 완료: ${finalSizeKB}KB / 목표: ${targetSizeKB}KB (정확도: ${accuracy}%, 품질: ${quality.toFixed(2)})`);
            
            return compressedData;
            
        } catch (error) {
            console.error('   ❌ 이미지 압축 오류:', error);
            throw new Error('이미지 압축 실패: ' + error.message);
        } finally {
            // Canvas 메모리 명시적 정리
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            canvas.width = 0;
            canvas.height = 0;
        }
    }
    
    onMouseDown(e) {
        // 롱프레스 시작
        this.startLongPress(e.clientX, e.clientY);
        
        // 드래그 준비
        this.touchState.startX = e.clientX;
        this.touchState.startY = e.clientY;
        this.touchState.lastTouch = { x: e.clientX, y: e.clientY };
        this.touchState.anchorView = this.screenToViewBox(e.clientX, e.clientY);
        this.touchState.startViewBox = {...this.viewBox};
        this.touchState.isDragging = false; // 아직 시작 안함
    }
    
    onMouseMove(e) {
        if (!this.touchState.lastTouch) return;
        
        // 이동 거리 계산 (롱프레스 취소 판단용)
        const moveDistance = Math.sqrt(
            Math.pow(e.clientX - this.touchState.startX, 2) + 
            Math.pow(e.clientY - this.touchState.startY, 2)
        );
        
        // 5px 이상 이동하면 롱프레스 취소하고 드래그 시작
        if (moveDistance > 5 && this.longPressTimer) {
            this.cancelLongPress();
            this.touchState.isDragging = true;
        }
        
        // 드래그 처리
        if (this.touchState.isDragging && this.touchState.anchorView) {
            const currentView = this.screenToViewBox(e.clientX, e.clientY);
            
            const deltaViewX = (currentView.x - this.touchState.anchorView.x) * this.panSensitivity;
            const deltaViewY = (currentView.y - this.touchState.anchorView.y) * this.panSensitivity;
            
            // ViewBox 이동 (크기는 유지)
            const originalWidth = this.viewBox.width;
            const originalHeight = this.viewBox.height;
            this.viewBox.x -= deltaViewX;
            this.viewBox.y -= deltaViewY;
            // 크기 유지 (드래그 중 축소 방지)
            this.viewBox.width = originalWidth;
            this.viewBox.height = originalHeight;
            
            this.updateViewBox();
        }
        
        // 현재 위치 저장
        this.touchState.lastTouch = { x: e.clientX, y: e.clientY };
    }
    
    onMouseUp(e) {
        // 드래그 중이었다면 wasDragging 플래그 설정 (클릭 이벤트 방지)
        if (this.touchState.isDragging) {
            this.touchState.wasDragging = true;
            setTimeout(() => {
                this.touchState.wasDragging = false;
            }, 100);
        }
        
        this.touchState.isDragging = false;
        this.touchState.lastTouch = null;
        this.touchState.anchorView = null;
        this.touchState.startViewBox = null;
    }
    
    /**
     * 터치 시작 이벤트 (핀치줌 지원 + 롱프레스 통합)
     */
    onTouchStart(e) {
        // 기본 브라우저 동작 방지 (페이지 확대/축소 방지)
        e.preventDefault();
        console.log('👆 onTouchStart, touches=', e.touches.length);
        this.logTime('onTouchStart 진입');
        this.lastTouchTime = Date.now();
        this.longPressTriggered = false;
        this.clearPendingSingleTap();
        
        const touches = e.touches;
        
        if (touches.length === 1) {
            // 단일 터치: 롱프레스 시작 + 드래그 준비
            const touch = touches[0];
            
            // 롱프레스 시작
            this.startLongPress(touch.clientX, touch.clientY);
            
            // 드래그 상태 초기화
            this.touchState.isDragging = false;
            this.touchState.isPinching = false;
            this.touchState.startX = touch.clientX;
            this.touchState.startY = touch.clientY;
            this.touchState.lastTouch = { x: touch.clientX, y: touch.clientY };
            this.touchState.anchorView = this.screenToViewBox(touch.clientX, touch.clientY);
            this.touchState.startViewBox = {...this.viewBox};
            
        } else if (touches.length === 2) {
            // 두 손가락: 핀치줌 시작
            this.cancelLongPress(); // 롱프레스 취소
            
            this.touchState.isDragging = false;
            this.touchState.isPinching = true;
            this.touchState.anchorView = null;
            
            // 더블탭 타이머 초기화 (핀치줌 시작 시 더블탭 오인식 방지)
            this.lastTapTime = 0;
            this.lastTapPosition = { x: 0, y: 0 };
            
            // 핀치줌 시작 시 rect를 한 번만 가져와서 캐시 (핀치줌 중 재사용)
            this.getCachedRect();
            
            // 두 손가락 사이 거리 계산
            const touch1 = touches[0];
            const touch2 = touches[1];
            const distance = this.getTouchDistance(touch1, touch2);
            
            this.touchState.lastPinchDistance = distance;
            this.touchState.startViewBox = {...this.viewBox};
        }
    }
    
    /**
     * 터치 이동 이벤트 (단순화된 ViewBox 방식 - 안정적)
     */
    onTouchMove(e) {
        // 항상 기본 동작 방지
        e.preventDefault();
        const touches = e.touches;
        this.logTime(`onTouchMove (touches=${touches.length}, isPinching=${this.touchState.isPinching})`);
        
        if (touches.length === 1 && !this.touchState.isPinching) {
            const touch = touches[0];
            
            // 이동 거리 계산
            const moveDistance = Math.sqrt(
                Math.pow(touch.clientX - this.touchState.startX, 2) + 
                Math.pow(touch.clientY - this.touchState.startY, 2)
            );
            
            // 10px 이상 이동하면 롱프레스 취소하고 드래그 시작 (더블탭 안정성 향상)
            if (moveDistance > 10 && this.longPressTimer) {
                this.cancelLongPress();
                this.touchState.isDragging = true;
            }
            
            // 단일 터치: 팬(드래그) - 손가락 방향과 일치
            if (this.touchState.isDragging && this.touchState.lastTouch) {
                // 현재/이전 터치 지점을 ViewBox 좌표로 변환
                const currentView = this.screenToViewBox(touch.clientX, touch.clientY);
                const lastView = this.screenToViewBox(this.touchState.lastTouch.x, this.touchState.lastTouch.y);
                
                const viewDeltaX = (lastView.x - currentView.x) * this.panSensitivity;
                const viewDeltaY = (lastView.y - currentView.y) * this.panSensitivity;
                
                // ViewBox 이동 (크기는 유지)
                const originalWidth = this.viewBox.width;
                const originalHeight = this.viewBox.height;
                this.viewBox.x += viewDeltaX;
                this.viewBox.y += viewDeltaY;
                // 크기 유지 (드래그 중 축소 방지)
                this.viewBox.width = originalWidth;
                this.viewBox.height = originalHeight;
                
                // Throttle 적용된 업데이트 (~60fps)
                this.updateViewBoxThrottled();
            }
            
            // 현재 위치 저장
            this.touchState.lastTouch = { x: touch.clientX, y: touch.clientY };
            
        } else if (touches.length === 2 && this.touchState.isPinching) {
            // 두 손가락: 핀치줌
            const touch1 = touches[0];
            const touch2 = touches[1];
            
            // 현재 거리
            const currentDistance = this.getTouchDistance(touch1, touch2);
            
            // 핀치 중심점 (스크린 좌표)
            const centerScreenX = (touch1.clientX + touch2.clientX) / 2;
            const centerScreenY = (touch1.clientY + touch2.clientY) / 2;
            
            if (this.touchState.lastPinchDistance > 0) {
                // 스케일 팩터
                const scaleFactor = currentDistance / this.touchState.lastPinchDistance;
                
                // 핀치줌이 실제로 발생했음을 표시 (거리 변화가 충분히 클 때만)
                if (Math.abs(scaleFactor - 1.0) > 0.01) {
                    this.touchState.wasPinching = true;
                }
                
                // 중심점을 ViewBox 좌표로 변환
                // 핀치줌 중에는 캐시된 rect 재사용 (getCachedRect는 캐시가 있으면 재사용)
                const rect = this.cachedRect || this.getCachedRect();
                const centerX = ((centerScreenX - rect.left) / rect.width) * this.viewBox.width + this.viewBox.x;
                const centerY = ((centerScreenY - rect.top) / rect.height) * this.viewBox.height + this.viewBox.y;
                
                // 새로운 ViewBox 크기
                const newWidth = this.viewBox.width / scaleFactor;
                const newHeight = this.viewBox.height / scaleFactor;
                
                // 최소/최대 크기 제한
                const minSize = (this.originalViewBox?.width || 1000) * 0.01;
                const maxSize = (this.originalViewBox?.width || 1000) * 10;
                
                if (newWidth >= minSize && newWidth <= maxSize) {
                    // 중심점 기준으로 ViewBox 재계산
                    const centerRatioX = (centerX - this.viewBox.x) / this.viewBox.width;
                    const centerRatioY = (centerY - this.viewBox.y) / this.viewBox.height;
                    
                    this.viewBox = {
                        x: centerX - newWidth * centerRatioX,
                        y: centerY - newHeight * centerRatioY,
                        width: newWidth,
                        height: newHeight
                    };
                    
                    // Throttle 적용된 업데이트 (~60fps)
                    this.updateViewBoxThrottled();
                }
            }
            
            // 거리 업데이트
            this.touchState.lastPinchDistance = currentDistance;
        }
    }
    
    /**
     * 터치 종료 이벤트 (롱프레스 + 더블탭 처리)
     */
    onTouchEnd(e) {
        e.preventDefault();
        this.logTime('onTouchEnd 진입');
        
        const touches = e.touches;
        
        if (touches.length === 0) {
            // 모든 터치 종료
            
            // 컨텍스트 메뉴가 열려있고, 드래그하지 않았고, 롱프레스가 아니면 메뉴 닫기
            const contextMenu = document.getElementById('context-menu');
            if (contextMenu.classList.contains('active') && 
                !this.touchState.isDragging && 
                !this.isLongPress) {
                
                // 메뉴 버튼을 터치한 게 아닌지 확인
                const touch = e.changedTouches[0];
                const target = document.elementFromPoint(touch.clientX, touch.clientY);
                if (!contextMenu.contains(target)) {
                    this.hideContextMenu();
                }
            }
            
            // 사진 클릭 또는 더블탭 감지
            // 핀치줌이나 드래그가 있었으면 탭으로 처리하지 않음
            // 핀치줌 종료 직후에는 더블탭 감지 비활성화 (오인식 방지)
            if (!this.longPressTriggered && 
                !this.touchState.wasDragging && 
                !this.touchState.wasPinching && 
                !this.touchState.isPinching &&
                e.changedTouches.length > 0 &&
                e.changedTouches.length === 1) { // 단일 터치만 처리 (핀치줌 종료 시 두 손가락이 동시에 떼어지는 경우 방지)
                const touch = e.changedTouches[0];
                const isTap = this.isTapGesture(touch);
                
                if (isTap) {
                    const doubled = this.handleDoubleTap(touch.clientX, touch.clientY);
                    if (doubled) {
                        this.clearPendingSingleTap();
                    } else {
                        const tappedPhoto = this.checkPhotoClick(touch.clientX, touch.clientY, { openModal: false });
                        if (tappedPhoto) {
                            this.queueSingleTapAction(() => this.openPhotoViewModal(tappedPhoto.id));
                        } else if (this.isTapOnCurrentLocation(touch.clientX, touch.clientY)) {
                            this.queueSingleTapAction(() => this.openCurrentLocationInfo());
                        } else {
                            const tappedText = this.checkTextClick(touch.clientX, touch.clientY, { openModal: false });
                            if (tappedText) {
                                this.queueSingleTapAction(() => this.openTextEditModal(tappedText.id));
                            } else {
                                this.clearPendingSingleTap();
                            }
                        }
                    }
                } else {
                    this.clearPendingSingleTap();
                }
            }
            
            // 롱프레스 확인
            if (!this.longPressTriggered) {
                this.cancelLongPress();
            } else {
                this.longPressTriggered = false;
                this.isLongPress = false;
                this.clearPendingSingleTap();
            }
            
            // 드래그 중이었다면 wasDragging 플래그 설정 (클릭 이벤트 방지)
            const wasDragging = this.touchState.isDragging;
            if (wasDragging) {
                this.touchState.wasDragging = true;
                setTimeout(() => {
                    this.touchState.wasDragging = false;
                }, 100);
            }
            
            // 핀치줌 중이었다면 wasPinching 플래그 설정 (클릭 이벤트 방지)
            const wasPinching = this.touchState.isPinching;
            if (wasPinching) {
                this.touchState.wasPinching = true;
                // 더블탭 타이머 초기화 (핀치줌 종료 후 더블탭 오인식 방지)
                this.lastTapTime = 0;
                this.lastTapPosition = { x: 0, y: 0 };
                setTimeout(() => {
                    this.touchState.wasPinching = false;
                }, 300); // 300ms로 증가 (더블탭 감지 시간과 동일하게)
            }
            
            // 드래그나 핀치줌이 끝났을 때 지도 동기화 (지도 모드일 때만)
            if ((wasDragging || wasPinching) && this.isMapMode && this.map && !this.syncingFromMap && this.dxfBoundsWGS84) {
                // 약간의 지연 후 동기화 (터치 이벤트 처리 완료 후)
                setTimeout(() => {
                    this.syncViewBoxToMapBounds();
                }, 50);
            }
            
            // rect 캐시 무효화 (ViewBox가 변경되었을 수 있음)
            this.cachedRect = null;
            
            // 상태 리셋
            this.touchState.isDragging = false;
            const wasPinchingBeforeReset = this.touchState.isPinching;
            this.touchState.isPinching = false;
            this.touchState.lastTouch = null;
            this.touchState.anchorView = null;
            this.touchState.startViewBox = null;
            
            // 핀치줌 종료 시 사진 다시 그리기 (최신 상태 반영)
            if (wasPinchingBeforeReset) {
                this._lastPhotoDrawTime = 0; // 강제로 다시 그리기
                requestAnimationFrame(() => {
                    this.drawPhotosCanvas();
                });
            }
            
        } else if (touches.length === 1) {
            // 두 손가락에서 한 손가락으로 전환
            this.cancelLongPress();
            
            const touch = touches[0];
            
            // 핀치줌이 끝났음을 표시
            const wasPinching = this.touchState.isPinching;
            if (wasPinching) {
                this.touchState.wasPinching = true;
                // 더블탭 타이머 초기화 (핀치줌 종료 후 더블탭 오인식 방지)
                this.lastTapTime = 0;
                this.lastTapPosition = { x: 0, y: 0 };
                setTimeout(() => {
                    this.touchState.wasPinching = false;
                }, 300); // 300ms로 증가 (더블탭 감지 시간과 동일하게)
                
                // 핀치줌 종료 시 지도 동기화 (지도 모드일 때만)
                if (this.isMapMode && this.map && !this.syncingFromMap && this.dxfBoundsWGS84) {
                    setTimeout(() => {
                        this.syncViewBoxToMapBounds();
                    }, 50);
                }
                
                // 핀치줌 종료 시 사진 다시 그리기 (최신 상태 반영)
                this._lastPhotoDrawTime = 0; // 강제로 다시 그리기
                requestAnimationFrame(() => {
                    this.drawPhotosCanvas();
                });
            }
            
            // 드래그 재시작 준비
            this.touchState.isDragging = false; // 드래그 재시작 방지 (핀치→팬 전환 시 끊김 방지)
            this.touchState.isPinching = false;
            this.touchState.startX = touch.clientX;
            this.touchState.startY = touch.clientY;
            this.touchState.lastTouch = { x: touch.clientX, y: touch.clientY };
        }

        this.logTime('onTouchEnd 종료');
    }
    
    /**
     * 두 터치 포인트 사이의 거리 계산
     */
    getTouchDistance(touch1, touch2) {
        const dx = touch2.clientX - touch1.clientX;
        const dy = touch2.clientY - touch1.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }
    
    /**
     * 화면 좌표를 현재 ViewBox 기준 좌표로 변환
     */
    screenToViewBox(screenX, screenY) {
        if (!this.svg) {
            return { x: screenX, y: screenY };
        }
        
        const point = this.svg.createSVGPoint ? this.svg.createSVGPoint() : { x: screenX, y: screenY };
        point.x = screenX;
        point.y = screenY;
        
        const ctm = this.svg.getScreenCTM();
        if (!ctm || !ctm.inverse) {
            // 폴백: 단순 비율 변환
            const rect = this.svg.getBoundingClientRect();
            const normX = (screenX - rect.left) / rect.width;
            const normY = (screenY - rect.top) / rect.height;
            return {
                x: this.viewBox.x + normX * this.viewBox.width,
                y: this.viewBox.y + normY * this.viewBox.height
            };
        }
        
        const svgPoint = point.matrixTransform(ctm.inverse());
        return { x: svgPoint.x, y: svgPoint.y };
    }
    
    /**
     * 특정 점을 중심으로 줌 (부드러운 확대/축소)
     */
    zoomAt(centerX, centerY, factor) {
        // 새로운 크기 계산
        // factor > 1: 확대 (viewBox 크기 감소) → viewBox.width / factor
        // factor < 1: 축소 (viewBox 크기 증가) → viewBox.width / factor
        let newWidth = this.viewBox.width / factor;
        let newHeight = this.viewBox.height / factor;
        
        // 최소/최대 크기 제한
        const minSize = (this.originalViewBox?.width || 1000) * 0.01; // 최대 100배 확대
        const maxSize = (this.originalViewBox?.width || 1000) * 10;   // 최대 10배 축소
        
        // 계단식 확대(버튼 등)에서 마지막 단계를 건너뛰지 않도록
        // 범위를 벗어나려 할 때는 취소 대신 경계값으로 강제 클램프
        if (newWidth < minSize) {
            const ratio = minSize / newWidth;
            newWidth = minSize;
            newHeight *= ratio;
        } else if (newWidth > maxSize) {
            const ratio = maxSize / newWidth;
            newWidth = maxSize;
            newHeight *= ratio;
        }
        
        // 중심점의 상대 위치 계산 (0~1 사이 값)
        const centerRatioX = (centerX - this.viewBox.x) / this.viewBox.width;
        const centerRatioY = (centerY - this.viewBox.y) / this.viewBox.height;
        
        // 새로운 ViewBox 계산 (중심점 유지)
        this.viewBox = {
            x: centerX - newWidth * centerRatioX,
            y: centerY - newHeight * centerRatioY,
            width: newWidth,
            height: newHeight
        };
        
        // 빠른 업데이트 (ViewBox만)
        this.updateViewBox();
        
        // 더블탭 줌 시 지도 동기화는 onTouchEnd에서 처리 (터치 종료 후)
    }
    
    /**
     * 사진 클릭 확인 (공통 함수)
     * @returns {boolean} 사진이 클릭되었으면 true, 아니면 false
     */
    checkPhotoClick(clientX, clientY, options = {}) {
        const { openModal = true } = options;
        // 최적화: rect 한 번만 가져오기
        const rect = this.getCachedRect();
        const clickX = clientX - rect.left;
        const clickY = clientY - rect.top;
        
        this.debugLog('👆 사진 클릭 확인:', { clickX, clickY });
        
        // 사진 점 클릭 확인 (원형 영역)
        for (let i = this.photos.length - 1; i >= 0; i--) {
            const photo = this.photos[i];
            
            // 사진 점 위치 계산
            const { x: screenX, y: screenY } = this.viewToCanvasCoords(photo.x, photo.y);
            
            // 클릭 영역 (30px - 터치하기 쉽게)
            const clickRadius = 30;
            
            // 거리 계산 (원형 클릭 영역)
            const distance = Math.sqrt(
                Math.pow(clickX - screenX, 2) + 
                Math.pow(clickY - screenY, 2)
            );
            
            this.debugLog(`   사진 ${i}: 거리=${distance.toFixed(1)}px, 기준=${clickRadius}px`);
            
            if (distance <= clickRadius) {
                this.debugLog(`✅ 사진 ${photo.id} 클릭 감지 (openModal=${openModal})`);
                if (openModal) {
                    this.openPhotoViewModal(photo.id);
                }
                return photo;
            }
        }
        
        this.debugLog('   → 사진이 클릭되지 않음');
        return null;
    }

    /**
     * 텍스트 클릭 확인
     */
    checkTextClick(clientX, clientY, options = {}) {
        const { openModal = true } = options;
        if (!this.texts || this.texts.length === 0) {
            return null;
        }

        const rect = this.getCachedRect();
        if (!rect) {
            return null;
        }

        const clickX = clientX - rect.left;
        const clickY = clientY - rect.top;
        
        // 실제 렌더링 크기와 동일하게 설정 (drawTexts에서 사용하는 값)
        const fontSize = 9;
        const padding = 3; // 텍스트 영역을 더 정확하게 (5px에서 3px로 축소)

        for (let i = this.texts.length - 1; i >= 0; i--) {
            const textObj = this.texts[i];
            const { x: screenX, y: screenY } = this.viewToCanvasCoords(textObj.x, textObj.y);

            // 실제 렌더링과 동일한 폰트 설정으로 텍스트 너비 측정
            this.ctx.save();
            this.ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
            const textWidth = this.ctx.measureText(textObj.text || '').width;
            this.ctx.restore();

            // 텍스트는 중앙 정렬로 그려지므로 (textAlign = 'center', textBaseline = 'middle')
            // 클릭 영역을 정확하게 계산
            const halfWidth = textWidth / 2;
            const halfHeight = fontSize / 2;
            const left = screenX - halfWidth - padding;
            const right = screenX + halfWidth + padding;
            const top = screenY - halfHeight - padding;
            const bottom = screenY + halfHeight + padding;

            // 클릭 위치가 텍스트 영역 내에 있는지 정확히 확인
            if (clickX >= left && clickX <= right && clickY >= top && clickY <= bottom) {
                if (openModal) {
                    this.openTextEditModal(textObj.id);
                }
                return textObj;
            }
        }

        return null;
    }

    /**
     * 캔버스 클릭 이벤트 (이모지 클릭 감지)
     * SVG 클릭 이벤트에서 호출됨
     */
    onCanvasClick(e) {
        if (Date.now() - this.lastTouchTime < 400) {
            return;
        }
        // 드래그 중이거나 방금 드래그가 끝났으면 클릭으로 처리하지 않음
        if (this.touchState.isDragging || this.touchState.wasDragging) {
            return;
        }
        
        // 사진 클릭 확인
        const clickedPhoto = this.checkPhotoClick(e.clientX, e.clientY, { openModal: true });

        if (!clickedPhoto) {
            this.checkTextClick(e.clientX, e.clientY, { openModal: true });
        }
    }
    
    /**
     * 사진 보기 모달 열기
     */
    async openPhotoViewModal(photoId) {
        const photo = this.photos.find(p => p.id === photoId);
        if (!photo) return;
        
        // 동일 좌표의 모든 사진 찾기 (약간의 오차 허용)
        const tolerance = 0.1; // 좌표 오차 허용 범위
        this.currentPhotoGroup = this.photos.filter(p => 
            Math.abs(p.x - photo.x) < tolerance && 
            Math.abs(p.y - photo.y) < tolerance
        ).map(p => p.id);
        
        // 현재 사진의 인덱스 찾기
        this.currentPhotoIndex = this.currentPhotoGroup.indexOf(photoId);
        if (this.currentPhotoIndex === -1) {
            this.currentPhotoIndex = 0;
        }
        
        console.log(`📸 사진 그룹: ${this.currentPhotoGroup.length}개 사진 발견 (인덱스: ${this.currentPhotoIndex + 1})`);
        
        // 사진 표시
        await this.displayPhotoInModal(photoId);
        
        // 네비게이션 UI 업데이트
        this.updatePhotoNavigationUI();
        
        // 모달 열기
        document.getElementById('photo-view-modal').classList.add('active');
    }
    
    /**
     * 모달에 사진 표시 (공통 함수)
     */
    async displayPhotoInModal(photoId) {
        const photo = this.photos.find(p => p.id === photoId);
        if (!photo) return;
        
        this.selectedPhotoId = photoId;
        
        const photoImageEl = document.getElementById('photo-view-image');
        if (photoImageEl) {
            photoImageEl.removeAttribute('src');
        }
        
        let imageData = photo.imageData;
        let fetchedTempData = false;
        
        if (!imageData) {
            if (!photo.fileName) {
                this.showToast('⚠️ 사진 파일 정보를 찾을 수 없습니다.');
                return;
            }
            
            try {
                this.showToast('📥 사진 다운로드 중...');
                imageData = await window.downloadFileByNameAsDataUrl(photo.fileName);
                fetchedTempData = !!imageData;
            } catch (error) {
                console.error('❌ 사진 다운로드 실패:', error);
                this.showToast('⚠️ 사진을 불러오지 못했습니다.');
            }
            
            if (!imageData) {
                return;
            }
        }
        
        if (photoImageEl) {
            photoImageEl.src = imageData;
        }
        this.tempFetchedPhotoData = fetchedTempData ? imageData : null;
        
        // 메모 표시 (인라인 편집)
        if (this.photoMemoInput) {
            this.photoMemoInput.disabled = false;
            this.photoMemoInput.value = photo.memo || '';
            setTimeout(() => {
                this.photoMemoInput.focus({ preventScroll: true });
            }, 50);
        }
    }
    
    /**
     * 사진 네비게이션 UI 업데이트
     */
    updatePhotoNavigationUI() {
        const prevBtn = document.getElementById('photo-prev-btn');
        const nextBtn = document.getElementById('photo-next-btn');
        const counterEl = document.getElementById('photo-counter');
        
        const photoCount = this.currentPhotoGroup.length;
        
        // 사진 카운터 업데이트
        if (counterEl) {
            if (photoCount > 1) {
                counterEl.textContent = `(${this.currentPhotoIndex + 1}/${photoCount})`;
            } else {
                counterEl.textContent = '';
            }
        }
        
        // 네비게이션 버튼 표시/숨김
        if (prevBtn) {
            prevBtn.style.display = photoCount > 1 ? 'flex' : 'none';
        }
        if (nextBtn) {
            nextBtn.style.display = photoCount > 1 ? 'flex' : 'none';
        }
    }
    
    /**
     * 사진 네비게이션 (이전/다음)
     */
    async navigatePhoto(direction) {
        if (this.currentPhotoGroup.length <= 1) return;
        
        // 인라인 메모 저장
        this.saveInlineMemo();
        
        // 인덱스 업데이트 (순환)
        this.currentPhotoIndex += direction;
        if (this.currentPhotoIndex < 0) {
            this.currentPhotoIndex = this.currentPhotoGroup.length - 1;
        } else if (this.currentPhotoIndex >= this.currentPhotoGroup.length) {
            this.currentPhotoIndex = 0;
        }
        
        // 사진 표시
        const nextPhotoId = this.currentPhotoGroup[this.currentPhotoIndex];
        await this.displayPhotoInModal(nextPhotoId);
        
        // UI 업데이트
        this.updatePhotoNavigationUI();
    }
    
    /**
     * 현재 위치에 사진 촬영 추가
     */
    capturePhotoAtCurrentLocation() {
        const currentPhoto = this.photos.find(p => p.id === this.selectedPhotoId);
        if (!currentPhoto) {
            this.showToast('⚠️ 현재 사진 정보를 찾을 수 없습니다.');
            return;
        }
        
        console.log(`📷 현재 위치에 사진 추가: (${currentPhoto.x}, ${currentPhoto.y})`);
        
        // 카메라 입력 트리거 (동일 좌표 저장을 위해 플래그 설정)
        this.pendingPhotoLocation = {
            x: currentPhoto.x,
            y: currentPhoto.y,
            width: currentPhoto.width,
            height: currentPhoto.height
        };
        
        document.getElementById('camera-input').click();
    }
    
    /**
     * 사진 보기 모달 닫기
     */
    closePhotoViewModal() {
        this.saveInlineMemo();
        const modal = document.getElementById('photo-view-modal');
        if (modal) {
            modal.classList.remove('active');
        }
        if (this.photoMemoInput) {
            this.photoMemoInput.blur();
            this.photoMemoInput.disabled = true;
            this.photoMemoInput.value = '';
        }
        const photoImageEl = document.getElementById('photo-view-image');
        if (photoImageEl && this.tempFetchedPhotoData) {
            photoImageEl.removeAttribute('src');
        }
        this.tempFetchedPhotoData = null;
        this.selectedPhotoId = null;
        
        // 사진 그룹 초기화
        this.currentPhotoGroup = [];
        this.currentPhotoIndex = 0;
    }
    
    /**
     * 줌 (ViewBox 중심점 기준)
     * @param {number} factor - 줌 배율 (1보다 크면 확대, 1보다 작으면 축소)
     */
    zoom(factor) {
        // 지도 모드가 아닐 때만 직접 줌 수행
        if (!this.isMapMode) {
            // ViewBox 중심점 계산
            const centerX = this.viewBox.x + this.viewBox.width / 2;
            const centerY = this.viewBox.y + this.viewBox.height / 2;
            
            // zoomAt 메서드 사용 (중심점 기준 확대)
            this.zoomAt(centerX, centerY, factor);
        } else {
            // 지도 모드일 때는 지도 줌을 사용 (지도가 viewBox를 동기화)
            if (this.map && this.dxfBoundsWGS84) {
                const currentZoom = this.map.getZoom();
                if (currentZoom !== null && currentZoom !== undefined) {
                    // factor > 1: 확대 (줌 레벨 증가)
                    // factor < 1: 축소 (줌 레벨 감소)
                    const newZoom = currentZoom + (factor > 1 ? 1 : -1);
                    this.map.setZoom(newZoom);
                }
            }
        }
    }
    
    openMemoModal(photoId) {
        const photo = this.photos.find(p => p.id === photoId);
        if (!photo) return;
        
        this.selectedPhotoId = photoId;
        
        document.getElementById('memo-image-preview').src = photo.imageData;
        document.getElementById('memo-text').value = photo.memo;
        document.getElementById('memo-modal').classList.add('active');
    }
    
    closeMemoModal() {
        const modal = document.getElementById('memo-modal');
        if (modal) {
            modal.classList.remove('active');
        }
        this.selectedPhotoId = null;
    }
    
    saveMemo() {
        const photo = this.photos.find(p => p.id === this.selectedPhotoId);
        if (!photo) return;
        
        photo.memo = document.getElementById('memo-text').value;
        this.metadataDirty = true;
        this.closeMemoModal();
        alert('메모가 저장되었습니다!');
        
        // Google Drive 자동 저장
        this.autoSave();
    }
    
    async deletePhoto(skipConfirm = false) {
        if (!this.selectedPhotoId) return;
        if (!skipConfirm) {
            const confirmMessage = '이 사진과 메모를 삭제하시겠습니까?\n\n삭제 시 Google Drive 사진 파일과 메타데이터에서도 제거됩니다.';
            if (!confirm(confirmMessage)) {
                return;
            }
        }
        
        const photoIndex = this.photos.findIndex(p => p.id === this.selectedPhotoId);
        if (photoIndex === -1) return;
        
        const photoToDelete = this.photos[photoIndex];
        console.log('🗑️ 사진 삭제 시작:', photoToDelete.id);
        
        try {
            // Google Drive에서 사진 파일 삭제
            if (window.currentDriveFile && window.deletePhotoFromDrive && photoToDelete.uploaded) {
                this.showToast('🗑️ 삭제 중...');
                const baseName = this.getDxfBaseName();
                const photoFileName = photoToDelete.fileName || `${baseName}_photo_${photoIndex + 1}.jpg`;
                
                console.log('   Google Drive에서 삭제:', photoFileName);
                await window.deletePhotoFromDrive(photoFileName);
                console.log('   ✅ Google Drive 삭제 완료');
            }
            
            // 로컬 배열에서 제거 (메모리 정리)
            // 명시적 메모리 해제
            if (photoToDelete.image && photoToDelete.image.src) {
                photoToDelete.image.src = ''; // Image 객체 메모리 해제
            }
            photoToDelete.image = null;
            photoToDelete.imageData = null;
            this.photos = this.photos.filter(p => p.id !== this.selectedPhotoId);
            console.log('   ✅ 로컬 배열에서 제거 완료');
            this.metadataDirty = true;
            
            this.redraw();
            
            // 메타데이터 업데이트 (사진 삭제는 즉시 저장)
            await this.autoSave(true); // force=true: 즉시 저장
            
            this.showToast('✅ 사진 삭제 완료');
            console.log('✅ 사진 삭제 완료:', photoToDelete.id);
        } catch (error) {
            console.error('❌ 사진 삭제 실패:', error);
            this.showToast('⚠️ 삭제 실패: ' + error.message);
            return;
        }

        this.closePhotoViewModal();
    }
    
    /**
     * 사진 재업로드 (업로드 실패한 사진을 다시 업로드)
     */
    async reuploadPhoto() {
        if (!this.selectedPhotoId) {
            this.showToast('⚠️ 선택된 사진이 없습니다');
            return;
        }
        
        const photo = this.photos.find(p => p.id === this.selectedPhotoId);
        if (!photo) {
            this.showToast('⚠️ 사진을 찾을 수 없습니다');
            return;
        }
        
        // 이미 업로드된 경우
        if (photo.uploaded === true) {
            this.showToast('ℹ️ 이미 정상 저장된 사진입니다');
            return;
        }
        
        try {
            this.showToast('📤 재업로드 중...');
            console.log('📤 사진 재업로드 시작:', photo.id);
            
            // Google Drive에 업로드
            if (window.currentDriveFile && window.saveToDrive) {
                const baseName = this.getDxfBaseName();
                const timestamp = new Date().toISOString()
                    .replace(/[-:]/g, '')
                    .replace(/T/, '_')
                    .replace(/\..+/, '')
                    .slice(4, 13); // MMDDHHmmss
                const fileName = `${baseName}_photo_${timestamp}.jpg`;
                
                photo.fileName = fileName;
                
                // 사진만 업로드 (메타데이터는 autoSave에서 처리)
                const appData = {
                    photos: [photo], // 이 사진만
                    allPhotos: this.photos, // 전체 사진 목록
                    texts: this.texts
                };
                
                await window.saveToDrive(appData, window.currentDriveFile.name);
                
                photo.uploaded = true;
                this.metadataDirty = true;
                
                console.log('   ✅ Google Drive 업로드 완료');
                
                // 화면 다시 그리기 (마커 색상 변경)
                this.redraw();
                
                this.showToast('✅ 재업로드 완료');
                console.log('✅ 사진 재업로드 완료:', photo.id);
            } else {
                throw new Error('Google Drive 연결이 필요합니다');
            }
        } catch (error) {
            console.error('❌ 사진 재업로드 실패:', error);
            this.showToast('⚠️ 재업로드 실패: ' + error.message);
        }
    }
    
    /**
     * Google Drive 자동 저장
     * 성능 최적화: Debounce 적용으로 네트워크 트래픽 감소 (약 80%)
     * 
     * ⚠️ 중요: 사용자 작업 내용 보호
     * - force=true일 때는 백그라운드 전환, 앱 종료, 화면 잠금과 관계없이 저장 진행
     * - 저장이 시작되면 중단 없이 완료되어야 함 (데이터 손실 방지)
     * 
     * @param {boolean} force - true면 debounce 없이 즉시 저장 (기본값: false)
     *                         - 사진 추가/삭제 시 자동으로 force=true 호출
     *                         - force=true일 때는 백그라운드 모드와 관계없이 저장 실행
     * 
     * 동작:
     * - 일반 호출: 마지막 변경 후 3초 대기 (Debounce)
     * - force=true: 즉시 저장 (사진 추가/삭제 등 중요한 작업)
     *   → 백그라운드 전환, 앱 종료, 화면 잠금과 관계없이 저장 진행
     * - force=false: 백그라운드 모드에서 일시 정지 (배터리 절약)
     * - 중복 실행 방지: 이미 저장 중이면 스킵 (완료 후 재실행 예약)
     * 
     * @example
     * await this.autoSave(); // Debounce 적용 (백그라운드에서 일시 정지)
     * await this.autoSave(true); // 즉시 저장 (백그라운드에서도 계속 진행)
     */
    async autoSave(force = false) {
        this.logTime(`autoSave 호출 (force=${force})`);
        // ⚠️ 중요: force=true일 때는 백그라운드 모드와 관계없이 저장 실행
        // 사용자 작업(사진 촬영, 텍스트 입력) 내용이 손실되지 않도록 보장
        // force=false일 때만 백그라운드 모드에서 일시 정지
        if (this.pauseAutoSave && !force) {
            console.log('⏸️ 백그라운드 모드 - 자동 저장 일시 정지 (force=false)');
            return;
        }
        
        // force=true일 때는 백그라운드 모드와 관계없이 저장 진행
        if (force && this.pauseAutoSave) {
            console.log('💾 강제 저장 실행 (force=true) - 백그라운드 모드와 관계없이 저장 진행');
        }
        
        // 이미 저장 중이면 처리 방법:
        // - force=false (일반 호출): 저장 완료 후 자동으로 다시 실행되도록 스킵
        // - force=true (즉시 저장): 저장 중이어도 대기하고 실행 (중복 방지를 위해 스킵)
        //   하지만 새로운 사진이 추가되었을 수 있으므로, 저장 완료 후 자동 재실행
        if (this.isAutoSaving) {
            if (force) {
                // force=true인 경우, 저장 중이면 저장 완료 후 다시 저장하도록 예약
                console.log('⏭️ 저장 중 - 저장 완료 후 자동 재실행 예약');
                // 저장 완료 후 재실행은 finally 블록에서 처리
                this.autoSavePending = true; // 저장 완료 후 재실행 플래그
            }
            console.log('⏭️ 자동 저장 이미 진행 중, 건너뜀');
            return;
        }
        
        // Debounce: 마지막 변경 후 일정 시간 대기 (force가 아닐 때만)
        // 성능 최적화: 메모 입력 등 빈번한 변경 시 불필요한 저장 방지
        if (!force) {
            clearTimeout(this.autoSaveTimeout);
            this.autoSaveTimeout = setTimeout(() => {
                this.autoSave(true); // 실제 저장 실행
            }, this.autoSaveDelay);
            return;
        }
        
        // Google Drive에 데이터 저장
        this.logTime('autoSave 실제 저장 시작 직전');
        console.log('💾 자동 저장 실행 (debounce 완료)...');
        console.log('   saveToDrive 함수:', typeof window.saveToDrive);
        console.log('   currentDriveFile:', window.currentDriveFile);
        
        if (!window.currentDriveFile && this.localSourceFile) {
            await this.ensureDriveContextForLocalFile(this.localSourceFile);
        }
        
        if (typeof window.saveToDrive !== 'function') {
            console.error('❌ saveToDrive 함수를 찾을 수 없습니다');
            this.showToast('⚠️ 저장 실패: 드라이브 기능을 사용할 수 없습니다');
            return;
        }
        
        if (!window.currentDriveFile) {
            console.warn('⚠️ Google Drive 파일 정보가 없습니다 (로컬 파일 또는 로그인 안 됨)');
            this.showToast('⚠️ 저장 실패: Google Drive에서 파일을 열어주세요');
            return;
        }
        
        try {
            this.isAutoSaving = true;
            
            // 업로드되지 않은 사진만 필터링
            const newPhotos = this.photos.filter(p => !p.uploaded);
            const hasNewPhotos = newPhotos.length > 0;
            const needsMetadataUpdate = this.metadataDirty || hasNewPhotos;
            
            console.log('📦 저장할 데이터:', {
                totalPhotosCount: this.photos.length,
                newPhotosCount: newPhotos.length,
                textsCount: this.texts.length,
                fileName: window.currentDriveFile.name
            });
            
            // 새로운 사진이 있거나 메타데이터가 변경되었을 때만 업로드
            if (needsMetadataUpdate) {
                // 저장 중 메시지 표시 (addPhotoAt에서 이미 표시한 경우 중복 방지)
                // 단, addPhotoAt에서 이미 "☁️ 저장 중 (구글드라이브)"를 표시했으므로
                // 여기서는 표시하지 않음 (중복 방지)
                
                const appData = {
                    photos: newPhotos,  // 새로운 사진만
                    allPhotos: this.photos,  // 전체 사진 목록 (메타데이터용)
                    texts: this.texts
                };
                
                const success = await window.saveToDrive(appData, window.currentDriveFile.name);
                
                if (success) {
                    // saveToDrive() 내에서 이미 photo.uploaded = true가 설정되었지만,
                    // 명시적으로 확인하고 메모리 해제
                    newPhotos.forEach(photo => {
                        // saveToDrive()에서 이미 uploaded = true로 설정되었을 수 있음
                        // 하지만 확실하게 설정하고 메모리 해제
                        photo.uploaded = true;
                        
                        // 명시적 메모리 해제
                        if (photo.image && photo.image.src) {
                            photo.image.src = ''; // Image 객체 메모리 해제
                        }
                        photo.image = null;
                        photo.imageData = null;
                    });
                    this.metadataDirty = false;
                    console.log('✅ 자동 저장 완료');
                    this.showToast('✅ 저장 완료');
                    
                    // 화면 다시 그리기 (마커 색상 실시간 업데이트: 초록색 → 빨간색)
                    // 사진 업로드 완료 후 즉시 마커 색상이 변경되도록
                    this.redraw();
                } else {
                    console.error('❌ 자동 저장 실패 (false 반환)');
                    this.showToast('⚠️ 저장 실패');
                }
            } else {
                console.log('⏭️ 새로운 사진/메타데이터 변경 없음 - 업로드 스킵');
            }
        } catch (error) {
            console.error('❌ 자동 저장 오류:', error);
            if (error && /로그인/.test(error.message || '')) {
                this.showToast('로그인이 만료되었습니다. Google Drive 버튼으로 다시 로그인하세요.');
            }
            this.showToast(`⚠️ 저장 실패: ${error.message}`);
        } finally {
            this.isAutoSaving = false;
            
            // 저장 완료 후 대기 중인 사진이 있으면 자동으로 재실행
            if (this.autoSavePending) {
                console.log('🔄 대기 중인 사진 저장 시작...');
                this.autoSavePending = false; // 플래그 초기화
                // 약간의 지연 후 재실행 (메타데이터 업데이트 시간 확보)
                setTimeout(() => {
                    this.autoSave(true).catch(error => {
                        console.error('❌ 자동 저장 재실행 오류:', error);
                    });
                }, 500);
            }
            this.logTime('autoSave 종료');
        }
    }
    
    /**
     * 사진 누락 확인 (Google Drive 메타데이터와 실제 파일 비교)
     */
    async checkMissingPhotos() {
        console.log('🔍 사진 누락 확인 시작...');
        
        // Google Drive 파일이 있는지 확인
        if (!window.currentDriveFile) {
            this.showToast('⚠️ Google Drive에서 파일을 열어주세요');
            return;
        }
        
        if (!window.driveManager) {
            this.showToast('⚠️ Google Drive Manager가 초기화되지 않았습니다');
            return;
        }
        
        // 사진 누락 확인 시작 - 토스트 메시지로 대체
        this.showToast('🔍 사진 누락 확인 중...');
        
        try {
            // 1. 메타데이터 로드
            console.log('📝 메타데이터 로드 중...');
            const metadata = await window.driveManager.loadMetadata(window.currentDriveFile.name);
            
            if (!metadata || !metadata.photos || metadata.photos.length === 0) {
                this.showToast('ℹ️ 저장된 사진이 없습니다');
                return;
            }
            
            // 2. 실제 파일 목록 가져오기
            console.log('📂 파일 목록 조회 중...');
            const files = await window.driveManager.listFiles();
            const fileNames = new Set(files.map(f => f.name));
            
            // 3. 누락된 사진 찾기
            console.log('🔎 누락된 사진 검색 중...');
            const missingPhotos = metadata.photos.filter(photo => {
                return photo.fileName && !fileNames.has(photo.fileName);
            });
            
            // 4. 결과 표시
            if (missingPhotos.length === 0) {
                console.log('✅ 모든 사진이 정상적으로 저장됨');
                alert('✅ 모든 사진이 정상적으로 저장되었습니다!\n\n' +
                      `총 사진 개수: ${metadata.photos.length}개`);
            } else {
                console.warn(`⚠️ 누락된 사진: ${missingPhotos.length}개`);
                console.log('누락된 사진 목록:', missingPhotos);
                
                const missingList = missingPhotos.map((photo, idx) => 
                    `${idx + 1}. ${photo.fileName || '(파일명 없음)'}`
                ).join('\n');
                
                alert(`⚠️ 누락된 사진이 발견되었습니다!\n\n` +
                      `총 사진: ${metadata.photos.length}개\n` +
                      `누락: ${missingPhotos.length}개\n\n` +
                      `누락된 사진:\n${missingList}\n\n` +
                      `💡 팁: 누락된 사진 위치는 초록색 큰 점으로 표시됩니다.`);
                
                // 5. 누락된 사진을 uploaded: false로 표시하여 초록색 점으로 렌더링
                missingPhotos.forEach(missingPhoto => {
                    const localPhoto = this.photos.find(p => p.id === missingPhoto.id);
                    if (localPhoto) {
                        localPhoto.uploaded = false;
                    }
                });
                
                // 화면 다시 그리기 (누락된 사진을 초록색 점으로 표시)
                this.redraw();
            }
            
        } catch (error) {
            this.showLoading(false);
            console.error('❌ 사진 누락 확인 실패:', error);
            this.showToast(`❌ 확인 실패: ${error.message || '알 수 없는 오류'}`);
        }
    }
    
    /**
     * 토스트 메시지 표시
     */
    /**
     * 도면 파일명 표시 업데이트
     */
    updateFileNameDisplay(fileName) {
        const fileNameText = document.getElementById('file-name-text');
        if (fileNameText) {
            // 현재 압축 용량 설정 표시
            const sizeText = this.imageSizeSetting === 'original' ? '원본' : this.imageSizeSetting;
            fileNameText.textContent = `${fileName} [${sizeText}]`;
        }
    }
    
    /**
     * 압축 용량 표시만 업데이트 (파일명은 유지)
     */
    updateImageSizeDisplay() {
        const fileNameText = document.getElementById('file-name-text');
        if (fileNameText) {
            // 기존 파일명 추출 (괄호 이전 부분)
            const currentText = fileNameText.textContent;
            const fileName = currentText.split(' [')[0] || currentText;
            const sizeText = this.imageSizeSetting === 'original' ? '원본' : this.imageSizeSetting;
            fileNameText.textContent = `${fileName} [${sizeText}]`;
        }
    }
    
    showToast(message) {
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
        
        // 애니메이션 CSS 추가 (한 번만)
        if (!document.getElementById('toast-animation-style')) {
            const style = document.createElement('style');
            style.id = 'toast-animation-style';
            style.textContent = `
                @keyframes toastFadeInOut {
                    0% { opacity: 0; transform: translateX(-50%) translateY(20px); }
                    10% { opacity: 1; transform: translateX(-50%) translateY(0); }
                    90% { opacity: 1; transform: translateX(-50%) translateY(0); }
                    100% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
                }
            `;
            document.head.appendChild(style);
        }
        
        document.body.appendChild(toast);
        
        // 2.5초 후 자동 제거
        setTimeout(() => {
            if (toast.parentNode) {
                toast.remove();
            }
        }, 2500);
    }
    
    /**
     * 이미지 목표 용량 가져오기
     * @returns {number|null} 목표 크기 (bytes) 또는 null (원본)
     */
    getImageTargetSize() {
        switch (this.imageSizeSetting) {
            case '500KB':
                return 500 * 1024;
            case '1MB':
                return 1024 * 1024;
            case '2MB':
                return 2 * 1024 * 1024;
            case 'original':
                return null; // 원본 (압축 없음)
            default:
                return 500 * 1024; // 기본값
        }
    }
    
    /**
     * 용량 조정 모달 표시
     */
    showImageSizeModal() {
        const modal = document.getElementById('image-size-modal');
        const currentDisplay = document.getElementById('current-size-display');
        
        if (!modal) {
            console.error('❌ 용량 조정 모달을 찾을 수 없습니다');
            return;
        }
        
        // 현재 설정 표시
        if (currentDisplay) {
            currentDisplay.textContent = this.imageSizeSetting;
        }
        
        // 현재 선택된 버튼 하이라이트
        const buttons = {
            '500KB': document.getElementById('size-500kb'),
            '1MB': document.getElementById('size-1mb'),
            '2MB': document.getElementById('size-2mb'),
            'original': document.getElementById('size-original')
        };
        
        Object.keys(buttons).forEach(key => {
            const btn = buttons[key];
            if (btn) {
                if (key === this.imageSizeSetting) {
                    btn.style.opacity = '1';
                    btn.style.transform = 'scale(1.05)';
                } else {
                    btn.style.opacity = '0.7';
                    btn.style.transform = 'scale(1)';
                }
            }
        });
        
        modal.classList.add('active');
    }
    
    /**
     * 용량 조정 모달 닫기
     */
    closeImageSizeModal() {
        const modal = document.getElementById('image-size-modal');
        if (modal) {
            modal.classList.remove('active');
        }
    }
    
    /**
     * 이미지 용량 설정 변경
     * @param {string} size - '500KB', '1MB', '2MB', 'original' 중 하나
     */
    setImageSize(size) {
        if (!['500KB', '1MB', '2MB', 'original'].includes(size)) {
            console.error('❌ 잘못된 용량 설정:', size);
            return;
        }
        
        this.imageSizeSetting = size;
        localStorage.setItem('dmap:imageSize', size);
        this.closeImageSizeModal();
        
        // 파일명 옆 용량 표시 업데이트
        this.updateImageSizeDisplay();
        
        const sizeText = size === 'original' ? '원본' : size;
        this.showToast(`✅ 사진 용량 설정: ${sizeText}`);
        console.log(`📏 이미지 용량 설정 변경: ${size}`);
    }
    
    /**
     * EPSG:5186 좌표를 WGS84로 변환
     * @param {number} x - EPSG:5186 X 좌표
     * @param {number} y - EPSG:5186 Y 좌표
     * @returns {Object} { lng, lat } WGS84 좌표
     */
    convert5186ToWGS84(x, y) {
        if (typeof proj4 === 'undefined') {
            console.error('❌ proj4 라이브러리가 로드되지 않았습니다');
            return null;
        }
        
        try {
            // EPSG:5186 정의 (한국 중부원점)
            proj4.defs('EPSG:5186', '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs');
            
            // EPSG:4326 정의 (WGS84)
            proj4.defs('EPSG:4326', '+proj=longlat +datum=WGS84 +no_defs');
            
            // 좌표 변환
            const [lng, lat] = proj4('EPSG:5186', 'EPSG:4326', [x, y]);
            
            return { lng, lat };
        } catch (error) {
            console.error('❌ 좌표 변환 실패:', error);
            return null;
        }
    }
    
    /**
     * DXF 도면 경계를 WGS84로 변환
     */
    convertDxfBoundsToWGS84() {
        if (!this.dxfBounds) {
            return;
        }
        
        const { minX, minY, maxX, maxY } = this.dxfBounds;
        
        // 네 모서리 좌표 변환
        const bottomLeft = this.convert5186ToWGS84(minX, minY);
        const bottomRight = this.convert5186ToWGS84(maxX, minY);
        const topLeft = this.convert5186ToWGS84(minX, maxY);
        const topRight = this.convert5186ToWGS84(maxX, maxY);
        
        if (!bottomLeft || !bottomRight || !topLeft || !topRight) {
            console.warn('⚠️ 좌표 변환 실패 - 지도 위치를 설정할 수 없습니다');
            this.dxfBoundsWGS84 = null;
            return;
        }
        
        // 최소/최대 위경도 계산
        const lngs = [bottomLeft.lng, bottomRight.lng, topLeft.lng, topRight.lng];
        const lats = [bottomLeft.lat, bottomRight.lat, topLeft.lat, topRight.lat];
        
        this.dxfBoundsWGS84 = {
            minLng: Math.min(...lngs),
            maxLng: Math.max(...lngs),
            minLat: Math.min(...lats),
            maxLat: Math.max(...lats)
        };
        
        console.log('✅ DXF 경계 WGS84 변환 완료:', this.dxfBoundsWGS84);
    }
    
    /**
     * 지도 초기화
     */
    async initMap() {
        if (this.mapInitialized || !window.google || !window.google.maps) {
            return;
        }
        
        try {
            // 지도 컨테이너를 완전히 보이게 설정 (Google Maps 초기화를 위해 필수)
            // Google Maps는 보이는 요소에만 타일을 로드합니다
            if (this.mapContainer) {
                this.mapContainer.style.visibility = 'visible';
                this.mapContainer.style.opacity = '1';
                this.mapContainer.style.display = 'block';
            }
            
            // 지도 중심 및 줌 설정
            let center = { lat: 36.3, lng: 127.8 }; // 기본값: 남한 중심
            let zoom = 7;
            
            // DXF 도면 경계가 있으면 해당 위치로 설정
            if (this.dxfBoundsWGS84) {
                const { minLat, maxLat, minLng, maxLng } = this.dxfBoundsWGS84;
                center = {
                    lat: (minLat + maxLat) / 2,
                    lng: (minLng + maxLng) / 2
                };
                
                // 경계 크기에 따라 줌 레벨 계산
                const latDiff = maxLat - minLat;
                const lngDiff = maxLng - minLng;
                const maxDiff = Math.max(latDiff, lngDiff);
                
                // 줌 레벨 추정 (경험적 공식)
                if (maxDiff > 1) zoom = 8;
                else if (maxDiff > 0.5) zoom = 9;
                else if (maxDiff > 0.2) zoom = 10;
                else if (maxDiff > 0.1) zoom = 11;
                else if (maxDiff > 0.05) zoom = 12;
                else if (maxDiff > 0.02) zoom = 13;
                else if (maxDiff > 0.01) zoom = 14;
                else zoom = 15;
                
                console.log('🗺️ DXF 도면 위치로 지도 설정:', { center, zoom, bounds: this.dxfBoundsWGS84 });
            }
            
            console.log('🗺️ Google Maps 초기화 시작...', { center, zoom });
            
            // Google Maps 객체 생성
            this.map = new google.maps.Map(this.mapElement, {
                zoom: zoom,
                center: center,
                mapTypeControl: false,
                fullscreenControl: false,
                streetViewControl: false,
                zoomControl: false,
                scaleControl: false,
                rotateControl: false,
                disableDefaultUI: true,
                gestureHandling: 'greedy',
                disableDoubleClickZoom: true,
                clickableIcons: false,
                mapTypeIds: ['roadmap', 'satellite', 'hybrid', '브이월드일반', '브이월드영상']
            });
            
            console.log('✅ Google Maps 객체 생성 완료');
            
            // 지도 좌표 → 화면 좌표 변환용 OverlayView
            if (!this.mapOverlay) {
                this.mapOverlay = new google.maps.OverlayView();
                this.mapOverlay.onAdd = () => {};
                this.mapOverlay.draw = () => {};
                this.mapOverlay.onRemove = () => {};
            }
            this.mapOverlay.setMap(this.map);
            
            // 브이월드 일반 지도 타일 레이어 정의
            const vworldRoadmapType = new google.maps.ImageMapType({
                getTileUrl: function(coord, zoom) {
                    const url = 'https://xdworld.vworld.kr/2d/Base/service/' + zoom + '/' + coord.x + '/' + coord.y + '.png';
                    console.log('🗺️ 브이월드 일반 타일 요청:', url);
                    return url;
                },
                tileSize: new google.maps.Size(256, 256),
                name: '브이월드일반',
                maxZoom: 19
            });
            
            // 브이월드 영상 지도 타일 레이어 정의
            const vworldSatelliteType = new google.maps.ImageMapType({
                getTileUrl: function(coord, zoom) {
                    const url = 'https://xdworld.vworld.kr/2d/Satellite/service/' + zoom + '/' + coord.x + '/' + coord.y + '.jpeg';
                    console.log('🛰️ 브이월드 위성 타일 요청:', url);
                    return url;
                },
                tileSize: new google.maps.Size(256, 256),
                name: '브이월드영상',
                maxZoom: 19
            });
            
            // 사용자 정의 지도 타입 추가
            this.map.mapTypes.set('브이월드일반', vworldRoadmapType);
            this.map.mapTypes.set('브이월드영상', vworldSatelliteType);
            
            console.log('✅ 브이월드 타일 레이어 추가 완료');
            
            // 지도가 완전히 로드될 때까지 대기 (최대 5초)
            await Promise.race([
                new Promise((resolve) => {
                    google.maps.event.addListenerOnce(this.map, 'idle', () => {
                        console.log('✅ 지도 타일 로드 완료 (idle 이벤트)');
                        resolve();
                    });
                }),
                new Promise((resolve) => {
                    setTimeout(() => {
                        console.log('⏰ 지도 로드 타임아웃 (5초)');
                        resolve();
                    }, 5000);
                })
            ]);
            
            // 초기화 완료 - 지도는 showMap에서 표시할 때까지 숨김 상태 유지
            // 하지만 display: none으로 하면 resize 이벤트가 제대로 작동하지 않으므로
            // visibility: hidden으로 유지 (크기는 유지하되 보이지 않게)
            if (this.mapContainer) {
                this.mapContainer.style.visibility = 'hidden';
                this.mapContainer.style.opacity = '0';
                // display는 block으로 유지 (resize 이벤트를 위해)
                this.mapContainer.style.display = 'block';
            }
            
            this.mapInitialized = true;
            console.log('✅ 지도 초기화 완료');
        } catch (error) {
            console.error('❌ 지도 초기화 실패:', error);
            console.error('에러 상세:', error.stack);
            if (this.mapContainer) {
                this.mapContainer.style.visibility = 'hidden';
                this.mapContainer.style.opacity = '0';
                this.mapContainer.style.display = 'none';
            }
        }
    }
    
    /**
     * 지도 표시
     * @param {string} mapType - 'google' 또는 'vworld'
     */
    async showMap(mapType) {
        if (!this.mapContainer || !this.mapElement) {
            console.error('❌ 지도 컨테이너를 찾을 수 없습니다');
            return;
        }
        
        // Google Maps API 로드 대기
        if (!window.google || !window.google.maps) {
            console.log('⏳ Google Maps API 로드 대기 중...');
            let retries = 0;
            while (!window.google || !window.google.maps) {
                await new Promise(resolve => setTimeout(resolve, 100));
                retries++;
                if (retries > 100) { // 10초 대기
                    console.error('❌ Google Maps API 로드 실패');
                    this.showToast('❌ 지도를 불러올 수 없습니다');
                    return;
                }
            }
        }
        
        // 지도 초기화
        if (!this.mapInitialized) {
            await this.initMap();
        }
        
        if (!this.map) {
            console.error('❌ 지도 객체가 초기화되지 않았습니다');
            return;
        }
        
        // 지도 타입 설정
        let mapTypeId;
        if (mapType === 'google') {
            mapTypeId = 'satellite'; // 구글 위성 지도
        } else if (mapType === 'vworld') {
            mapTypeId = '브이월드영상'; // 브이월드 위성 지도
        } else {
            console.error('❌ 잘못된 지도 타입:', mapType);
            return;
        }
        
        // 지도 컨테이너를 먼저 완전히 표시 (resize 이벤트를 위해 필수)
        // display는 이미 block이므로 visibility와 opacity만 변경
        this.mapContainer.style.display = 'block';
        this.mapContainer.style.visibility = 'visible';
        this.mapContainer.style.opacity = '1';
        this.mapContainer.classList.add('visible');
        
        // 약간의 지연 후 resize 이벤트 트리거 (렌더링 완료 대기)
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // SVG 배경을 투명하게 (이미 CSS에서 설정됨)
        this.svg.style.background = 'transparent';
        
        // 지도 타입 설정
        console.log(`🗺️ 지도 타입 설정: ${mapType} -> ${mapTypeId}`);
        this.map.setMapTypeId(mapTypeId);
        this.currentMapType = mapType;
        
        // 지도 크기 조정 (resize 이벤트 발생) - 약간의 지연 후
        setTimeout(() => {
            if (this.map && window.google && window.google.maps) {
                console.log('🔄 지도 resize 이벤트 트리거');
                google.maps.event.trigger(this.map, 'resize');
                
                // DXF 도면 경계가 있으면 해당 영역으로 맞추기
                if (this.dxfBoundsWGS84) {
                    const { minLat, maxLat, minLng, maxLng } = this.dxfBoundsWGS84;
                    const bounds = new google.maps.LatLngBounds(
                        new google.maps.LatLng(minLat, minLng),
                        new google.maps.LatLng(maxLat, maxLng)
                    );
                    
                    console.log('📍 DXF 도면 경계로 지도 맞추기:', bounds);
                    // bounds로 맞추기 (패딩 추가)
                    this.map.fitBounds(bounds, {
                        padding: { top: 50, right: 50, bottom: 50, left: 50 }
                    });
                    
                    // 지도 bounds와 SVG viewBox 동기화
                    this.syncMapBoundsToViewBox();
                } else {
                    // 지도 중심 재설정 (타일이 제대로 로드되도록)
                    const center = this.map.getCenter();
                    if (center) {
                        console.log('📍 지도 중심 재설정:', center.lat(), center.lng());
                        this.map.setCenter(center);
                    }
                }
                
                // 지도 bounds 변경 리스너 추가 (지도 이동/줌 시 SVG viewBox 동기화)
                if (this.mapBoundsListener) {
                    google.maps.event.removeListener(this.mapBoundsListener);
                }
                // 최적화: bounds_changed 이벤트를 더블 버퍼링으로 처리
                let mapSyncPending = false;
                this.mapBoundsListener = google.maps.event.addListener(this.map, 'bounds_changed', () => {
                    if (!mapSyncPending && this.isMapMode && this.dxfBoundsWGS84 && !this.syncingFromViewBox) {
                        mapSyncPending = true;
                        requestAnimationFrame(() => {
                            if (this.isMapMode && this.dxfBoundsWGS84) {
                                this.syncMapBoundsToViewBox();
                                // 현재 위치 마커 가시성 확인 및 자동 제거
                                this.checkCurrentLocationMarkerVisibility();
                            }
                            mapSyncPending = false;
                        });
                    } else if (!this.isMapMode) {
                        // 지도 모드가 아니어도 현재 위치 마커 가시성 확인
                        this.checkCurrentLocationMarkerVisibility();
                    }
                });
                
                this.isMapMode = true;
                
                // 타일 로드 확인을 위한 idle 이벤트 리스너 (초기 로드 후 한 번만)
                google.maps.event.addListenerOnce(this.map, 'idle', () => {
                    console.log('✅ 지도 타일 로드 완료 (showMap 후)');
                    // idle 이벤트 후에도 한 번 더 동기화
                    if (this.dxfBoundsWGS84) {
                        this.syncMapBoundsToViewBox();
                    }
                });
            }
        }, 500);
        
        console.log(`✅ 지도 표시: ${mapType}`);
        this.showToast(`🗺️ ${mapType === 'google' ? '구글맵' : '브이월드'} 표시`);
    }
    
    /**
     * SVG viewBox를 지도 bounds로 동기화 (역방향)
     * 도면 확대/축소/이동 시 지도도 함께 변경
     */
    syncViewBoxToMapBounds() {
        if (!this.map || !this.dxfBounds || !this.dxfBoundsWGS84 || this.syncingFromMap) {
            return;
        }
        
        try {
            this.syncingFromViewBox = true;
            
            // 현재 ViewBox의 중심점과 크기
            const viewBoxCenterX = this.viewBox.x + this.viewBox.width / 2;
            const viewBoxCenterY = -(this.viewBox.y + this.viewBox.height / 2); // Y축 반전 해제
            
            // DXF 경계 정보
            const { minX, minY, maxX, maxY } = this.dxfBounds;
            const { minLat, maxLat, minLng, maxLng } = this.dxfBoundsWGS84;
            
            // DXF 좌표 범위
            const dxfWidth = maxX - minX;
            const dxfHeight = maxY - minY;
            
            // DXF 위경도 범위
            const dxfLatRange = maxLat - minLat;
            const dxfLngRange = maxLng - minLng;
            
            // 스케일 비율
            const scaleX = dxfLngRange / dxfWidth;
            const scaleY = dxfLatRange / dxfHeight;
            
            // DXF 중심점
            const dxfCenterX = (minX + maxX) / 2;
            const dxfCenterY = (minY + maxY) / 2;
            const dxfCenterLat = (minLat + maxLat) / 2;
            const dxfCenterLng = (minLng + maxLng) / 2;
            
            // ViewBox 중심점을 DXF 좌표로 변환
            const deltaX = viewBoxCenterX - dxfCenterX;
            const deltaY = viewBoxCenterY - dxfCenterY;
            
            // 위경도로 변환
            const deltaLng = deltaX * scaleX;
            const deltaLat = deltaY * scaleY;
            
            // 지도 중심점 계산
            const mapCenterLat = dxfCenterLat + deltaLat;
            const mapCenterLng = dxfCenterLng + deltaLng;
            const targetCenter = new google.maps.LatLng(mapCenterLat, mapCenterLng);
            
            // ViewBox 크기 변경 여부 판단
            const widthChanged = !this.lastSyncedViewBoxSize ||
                Math.abs(this.lastSyncedViewBoxSize.width - this.viewBox.width) > 1 ||
                Math.abs(this.lastSyncedViewBoxSize.height - this.viewBox.height) > 1;
            
            if (widthChanged) {
                // ViewBox 크기를 위경도 범위로 변환
                const mapLatRange = this.viewBox.height * scaleY;
                const mapLngRange = this.viewBox.width * scaleX;
                
                // 지도 bounds 계산
                const mapMinLat = mapCenterLat - mapLatRange / 2;
                const mapMaxLat = mapCenterLat + mapLatRange / 2;
                const mapMinLng = mapCenterLng - mapLngRange / 2;
                const mapMaxLng = mapCenterLng + mapLngRange / 2;
                
                const bounds = new google.maps.LatLngBounds(
                    new google.maps.LatLng(mapMinLat, mapMinLng),
                    new google.maps.LatLng(mapMaxLat, mapMaxLng)
                );
                
                // 지도 bounds 업데이트 (애니메이션 없이)
                this.map.fitBounds(bounds);
                this.lastSyncedViewBoxSize = {
                    width: this.viewBox.width,
                    height: this.viewBox.height
                };
                
                console.log('🔄 SVG viewBox → 지도 bounds 동기화 (zoom 포함):', {
                    viewBox: this.viewBox,
                    mapBounds: { minLat: mapMinLat, maxLat: mapMaxLat, minLng: mapMinLng, maxLng: mapMaxLng }
                });
            } else {
                // 크기 변화가 없으면 지도 중심만 이동 (줌 유지)
                if (this.map.getCenter && this.map.panTo) {
                    this.map.panTo(targetCenter);
                } else {
                    this.map.setCenter(targetCenter);
                }
                console.log('🔄 SVG viewBox → 지도 중심 동기화 (줌 유지):', targetCenter.toJSON());
            }
        } catch (error) {
            console.error('❌ viewBox → 지도 동기화 실패:', error);
        } finally {
            this.syncingFromViewBox = false;
        }
    }
    
    /**
     * 지도 bounds를 SVG viewBox로 동기화
     * DXF 도면의 EPSG:5186 좌표를 지도 위경도 좌표계에 맞게 매핑
     */
    syncMapBoundsToViewBox() {
        if (!this.map || !this.dxfBounds || !this.dxfBoundsWGS84) {
            return;
        }
        
        try {
            const bounds = this.map.getBounds();
            if (!bounds) return;
            
            const ne = bounds.getNorthEast(); // 북동쪽
            const sw = bounds.getSouthWest(); // 남서쪽
            
            // 지도 bounds의 위경도
            const mapMinLng = sw.lng();
            const mapMaxLng = ne.lng();
            const mapMinLat = sw.lat();
            const mapMaxLat = ne.lat();
            
            // DXF 경계의 위경도 (WGS84)
            const { minLat, maxLat, minLng, maxLng } = this.dxfBoundsWGS84;
            // DXF 경계의 EPSG:5186 좌표
            const { minX, minY, maxX, maxY } = this.dxfBounds;
            
            // DXF 경계의 크기 (EPSG:5186)
            const dxfWidth = maxX - minX;
            const dxfHeight = maxY - minY;
            
            // DXF 경계의 위경도 범위 (WGS84)
            const dxfLatRange = maxLat - minLat;
            const dxfLngRange = maxLng - minLng;
            
            // 지도 bounds의 위경도 범위
            const mapLatRange = mapMaxLat - mapMinLat;
            const mapLngRange = mapMaxLng - mapMinLng;
            
            // DXF 좌표계와 지도 좌표계 간의 스케일 비율 계산
            // 경도 방향 스케일: 지도 경도 범위 / DXF 경도 범위 = DXF 좌표 단위 / 지도 좌표 단위
            const scaleX = dxfWidth / dxfLngRange; // 미터/도
            const scaleY = dxfHeight / dxfLatRange; // 미터/도
            
            // 지도 bounds의 중심점
            const mapCenterLat = (mapMinLat + mapMaxLat) / 2;
            const mapCenterLng = (mapMinLng + mapMaxLng) / 2;
            
            // DXF 경계의 중심점 (WGS84)
            const dxfCenterLat = (minLat + maxLat) / 2;
            const dxfCenterLng = (minLng + maxLng) / 2;
            
            // DXF 경계의 중심점 (EPSG:5186)
            const dxfCenterX = (minX + maxX) / 2;
            const dxfCenterY = (minY + maxY) / 2;
            
            // 지도 중심점에 해당하는 DXF 좌표 계산
            // 지도 중심과 DXF 중심의 차이를 DXF 좌표로 변환
            const deltaLng = mapCenterLng - dxfCenterLng; // 경도 차이 (도)
            const deltaLat = mapCenterLat - dxfCenterLat; // 위도 차이 (도)
            
            // DXF 좌표로 변환
            const deltaX = deltaLng * scaleX;
            const deltaY = deltaLat * scaleY;
            
            // 지도 중심에 해당하는 DXF 좌표
            const mapCenterDxfX = dxfCenterX + deltaX;
            const mapCenterDxfY = dxfCenterY + deltaY;
            
            // 지도 bounds에 해당하는 DXF 좌표 범위
            const mapDxfWidth = mapLngRange * scaleX;
            const mapDxfHeight = mapLatRange * scaleY;
            
            // SVG viewBox 설정 (DXF 좌표계 사용)
            this.viewBox = {
                x: mapCenterDxfX - mapDxfWidth / 2,
                y: -(mapCenterDxfY + mapDxfHeight / 2), // Y축 반전 (SVG는 위에서 아래로 증가)
                width: mapDxfWidth,
                height: mapDxfHeight
            };
            
            // ViewBox 업데이트 (지도 동기화는 하지 않음 - 무한 루프 방지)
            this.svg.setAttribute('viewBox', 
                `${this.viewBox.x} ${this.viewBox.y} ${this.viewBox.width} ${this.viewBox.height}`);
            this.drawPhotosCanvas();
            this.lastSyncedViewBoxSize = {
                width: this.viewBox.width,
                height: this.viewBox.height
            };
            
            console.log('🔄 지도 bounds → SVG viewBox 동기화:', {
                mapBounds: { minLat: mapMinLat, maxLat: mapMaxLat, minLng: mapMinLng, maxLng: mapMaxLng },
                dxfBoundsWGS84: this.dxfBoundsWGS84,
                dxfBounds: this.dxfBounds,
                scale: { scaleX, scaleY },
                viewBox: this.viewBox
            });
        } catch (error) {
            console.error('❌ 지도 bounds 동기화 실패:', error);
        } finally {
            this.syncingFromMap = false;
        }
    }
    
    /**
     * 지도 숨기기
     */
    hideMap() {
        if (!this.mapContainer) {
            return;
        }
        
        // 지도 bounds 리스너 제거
        if (this.mapBoundsListener && this.map && window.google && window.google.maps) {
            google.maps.event.removeListener(this.mapBoundsListener);
            this.mapBoundsListener = null;
        }
        
        // throttle timeout 제거
        if (this.boundsChangeTimeout) {
            clearTimeout(this.boundsChangeTimeout);
            this.boundsChangeTimeout = null;
        }
        
        this.isMapMode = false;
        this.lastSyncedViewBoxSize = null;
        
        this.mapContainer.style.display = 'none';
        this.mapContainer.style.visibility = 'hidden';
        this.mapContainer.style.opacity = '0';
        this.mapContainer.classList.remove('visible');
        this.currentMapType = null;
        
        // SVG 배경 복원
        this.svg.style.background = '#e8e8e8';
        
        // 원본 ViewBox로 복원 (지도 모드가 아닐 때)
        if (this.originalViewBox) {
            this.viewBox = {...this.originalViewBox};
            this.updateViewBox();
        }
        
        // 현재 위치 마커 제거
        this.clearCurrentLocationMarker();
        
        console.log('✅ 지도 숨김');
        this.showToast('🗺️ 지도 숨김');
    }
    
    /**
     * 현재 위치 마커 제거
     */
    clearCurrentLocationMarker() {
        if (this.currentLocationMarker) {
            this.currentLocationMarker.setMap(null);
            this.currentLocationMarker = null;
        }
        if (this.currentLocationInfoWindow) {
            this.currentLocationInfoWindow.close();
            this.currentLocationInfoWindow = null;
        }
        this.currentLocationData = null;
    }
    
    /**
     * 현재 위치 마커 가시성 확인 및 자동 제거
     * 마커가 화면 밖으로 나가면 자동으로 제거
     */
    checkCurrentLocationMarkerVisibility() {
        if (this.currentLocationMarker && this.map) {
            const bounds = this.map.getBounds();
            const markerPosition = this.currentLocationMarker.getPosition();
            
            // 마커가 현재 지도 뷰의 경계 밖에 있는지 확인
            if (bounds && markerPosition && !bounds.contains(markerPosition)) {
                // 열린 정보창 닫기
                if (this.currentLocationInfoWindow) {
                    this.currentLocationInfoWindow.close();
                    this.currentLocationInfoWindow = null;
                }
                // 마커가 뷰에서 벗어나면 자동으로 제거
                this.currentLocationMarker.setMap(null);
                this.currentLocationMarker = null;
                this.currentLocationData = null;
                console.log('📍 현재 위치 마커가 화면 밖으로 나가 제거됨');
            }
        }
    }
    
    /**
     * 현재 위치 표시
     */
    async showCurrentLocation() {
        if (!this.map) {
            this.showToast('지도를 먼저 켜주세요');
            return;
        }
        
        // 기존 마커 제거
        this.clearCurrentLocationMarker();
        
        if (!navigator.geolocation) {
            this.showToast('위치 정보를 사용할 수 없습니다');
            return;
        }
        
        // 모바일 감지
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        
        // 위치 요청 옵션
        const options = {
            enableHighAccuracy: true, // GPS 사용
            timeout: isMobile ? 15000 : 10000,
            maximumAge: 0 // 캐시 사용 안 함
        };
        
        try {
            const position = await new Promise((resolve, reject) => {
                navigator.geolocation.getCurrentPosition(resolve, reject, options);
            });
            
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const accuracy = position.coords.accuracy;
            const timestamp = position.timestamp;
            const currentLocation = { lat, lng };
            
            // 위치 정보 로깅
            const now = new Date();
            const positionTime = new Date(timestamp);
            const timeDiff = (now - positionTime) / 1000;
            
            console.log('📍 위치 정보:', {
                위도: lat.toFixed(6),
                경도: lng.toFixed(6),
                정확도: accuracy.toFixed(1) + 'm',
                획득시간: positionTime.toLocaleTimeString('ko-KR'),
                현재시간: now.toLocaleTimeString('ko-KR'),
                시간차이: timeDiff.toFixed(1) + '초'
            });
            
            // 정확도 경고
            if (accuracy > 100) {
                console.warn('⚠️ 위치 정확도가 낮습니다 (' + accuracy.toFixed(0) + 'm)');
            }
            
            // 현재 위치 중심으로 확대
            const currentZoom = this.map.getZoom();
            this.map.setCenter(currentLocation);
            this.map.setZoom(Math.max(currentZoom, 15));
            
            // 현재 위치 정보 저장
            this.currentLocationData = {
                lat,
                lng,
                accuracy,
                positionTime,
                isMobile
            };
            
            // 현재 위치 마커 생성
            this.currentLocationMarker = new google.maps.Marker({
                position: currentLocation,
                map: this.map,
                icon: {
                    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(`
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
                            <text x="12" y="20" font-family="Arial, sans-serif" font-size="24" text-anchor="middle" fill="#FF0000">📌</text>
                        </svg>
                    `),
                    scaledSize: new google.maps.Size(isMobile ? 28 : 32, isMobile ? 28 : 32),
                    anchor: new google.maps.Point(isMobile ? 14 : 16, isMobile ? 14 : 16)
                },
                title: '현재 위치 (정확도: ' + accuracy.toFixed(0) + 'm)',
                zIndex: 1000,
                optimized: !isMobile
            });
            
            // 마커 클릭 시 정보창 표시
            this.currentLocationMarker.addListener('click', () => {
                this.openCurrentLocationInfo();
            });
            
            console.log('✅ 현재 위치 표시 완료 (정확도: ' + accuracy.toFixed(0) + 'm)');
            this.showToast('📍 현재 위치 표시 완료');
            
        } catch (error) {
            console.error('❌ 위치 정보를 가져올 수 없습니다:', error);
            let errorMessage = '위치 정보를 가져올 수 없습니다.';
            
            if (isMobile) {
                switch(error.code) {
                    case error.PERMISSION_DENIED:
                        errorMessage = '위치 접근 권한이 거부되었습니다. 브라우저 설정에서 위치 권한을 허용해주세요.';
                        break;
                    case error.POSITION_UNAVAILABLE:
                        errorMessage = '위치 정보를 사용할 수 없습니다. 네트워크 연결을 확인해주세요.';
                        break;
                    case error.TIMEOUT:
                        errorMessage = '위치 정보 요청 시간이 초과되었습니다. 다시 시도해주세요.';
                        break;
                }
            }
            
            this.showToast(errorMessage);
        }
    }
    
    /**
     * 현재 위치 정보창 표시
     */
    openCurrentLocationInfo() {
        if (!this.map || !this.currentLocationData) {
            this.showToast('현재 위치 정보가 없습니다. 다시 측정해주세요.');
            return;
        }
        
        const { lat, lng, accuracy, positionTime, isMobile } = this.currentLocationData;
        const now = new Date();
        const timeDiff = Math.max(0, (now - positionTime) / 1000);
        const latText = lat.toFixed(6);
        const lngText = lng.toFixed(6);
        const accuracyText = accuracy.toFixed(0);
        const infoContent = `
            <div style="padding: 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                <div style="font-weight: 700; font-size: 14px; margin-bottom: 8px;">📍 현재 위치</div>
                <div style="font-size: 12px; color: #666; line-height: 1.6;">
                    <div>위도: ${latText}</div>
                    <div>경도: ${lngText}</div>
                    <div>정확도: ${accuracyText}m</div>
                    <div>획득: ${positionTime.toLocaleTimeString('ko-KR')}</div>
                    ${timeDiff > 10 ? `<div style="color: #ef4444;">⚠️ ${timeDiff.toFixed(0)}초 전 데이터</div>` : ''}
                </div>
            </div>
        `;
        
        if (!this.currentLocationInfoWindow) {
            this.currentLocationInfoWindow = new google.maps.InfoWindow({
                maxWidth: isMobile ? 280 : 320
            });
        }
        this.currentLocationInfoWindow.setContent(infoContent);
        
        const latLng = new google.maps.LatLng(lat, lng);
        if (this.currentLocationMarker) {
            this.currentLocationInfoWindow.open(this.map, this.currentLocationMarker);
        } else {
            this.currentLocationInfoWindow.setPosition(latLng);
            this.currentLocationInfoWindow.open(this.map);
        }
        
        try {
            const currentZoom = this.map.getZoom();
            this.map.setZoom(Math.max(currentZoom || 15, 15));
            this.map.panTo(latLng);
        } catch (error) {
            console.warn('⚠️ 현재 위치로 지도 이동 실패:', error);
        }
    }
    
    /**
     * 현재 위치 이모지 근처 탭 여부 확인
     */
    isTapOnCurrentLocation(screenX, screenY) {
        if (!this.currentLocationData || !this.isMapMode) {
            return false;
        }
        const screenPos = this.getCurrentLocationScreenPosition();
        if (!screenPos) {
            return false;
        }
        const distance = Math.hypot(screenX - screenPos.x, screenY - screenPos.y);
        return distance <= 40; // 40px 이내를 탭으로 인식
    }
    
    /**
     * 현재 위치를 화면 좌표로 변환
     */
    getCurrentLocationScreenPosition() {
        if (!this.map || !this.mapOverlay || !this.currentLocationData) {
            return null;
        }
        const projection = this.mapOverlay.getProjection();
        if (!projection) {
            return null;
        }
        const latLng = new google.maps.LatLng(this.currentLocationData.lat, this.currentLocationData.lng);
        const containerPoint = projection.fromLatLngToContainerPixel(latLng);
        if (!containerPoint) {
            return null;
        }
        const mapDiv = this.map.getDiv();
        if (!mapDiv) {
            return null;
        }
        const rect = mapDiv.getBoundingClientRect();
        return {
            x: rect.left + containerPoint.x,
            y: rect.top + containerPoint.y
        };
    }
    
    /**
     * ZIP 내보내기 기능 제거됨
     * 
     * 이유: Google Drive 자동 저장으로 대체
     * - 사진/텍스트 추가 시 자동으로 Google Drive에 업로드
     * - JSZip 라이브러리 불필요 (~100KB 절감)
     * 
     * 필요 시 아래 코드 주석 해제하고 JSZip 라이브러리 추가
     */
    
    /*
    async exportToZip() {
        if (!this.dxfData) {
            alert('DXF 파일을 먼저 로드해주세요.');
            return;
        }
        
        if (typeof JSZip === 'undefined') {
            alert('ZIP 라이브러리가 로드되지 않았습니다.');
            return;
        }
        
        // ... ZIP 생성 로직 ...
    }
    
    createModifiedDxf() {
        // DXF 수정본 생성 로직
    }
    */
    
    downloadBlob(blob, filename) {
        // iOS 감지
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        
        console.log('다운로드 환경:', {
            isIOS: isIOS,
            isSafari: isSafari,
            userAgent: navigator.userAgent
        });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        
        // iOS Safari 특별 처리
        if (isIOS) {
            // iOS에서는 target="_blank" 필요
            a.target = '_blank';
            
            // 파일 크기 확인
            const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
            console.log(`파일 크기: ${sizeMB}MB`);
            
            // 사용자에게 안내
            if (isSafari) {
                // Safari: 파일이 새 탭에서 열림
                console.log('iOS Safari: 파일이 새 탭에서 열립니다.');
            } else {
                // Chrome: 다운로드 폴더로 저장
                console.log('iOS Chrome: 파일이 다운로드됩니다.');
            }
        }
        
        document.body.appendChild(a);
        
        // iOS에서는 사용자 제스처 컨텍스트에서 실행되어야 함
        try {
            a.click();
        } catch (error) {
            console.error('다운로드 클릭 오류:', error);
            // 폴백: 새 창으로 열기
            window.open(url, '_blank');
        }
        
        document.body.removeChild(a);
        
        // iOS에서는 URL을 즉시 해제하면 안됨
        if (isIOS) {
            setTimeout(() => {
                URL.revokeObjectURL(url);
                console.log('URL 해제됨');
            }, 1000);
            
            // iOS 사용자 안내
            setTimeout(() => {
                if (isSafari) {
                    alert('💾 파일 저장 방법:\n\n' +
                          '1. 새 탭이 열리면 화면을 길게 터치\n' +
                          '2. "파일에 다운로드" 선택\n' +
                          '3. "파일" 앱에서 확인\n\n' +
                          '또는:\n' +
                          '공유 버튼(↑) → "파일에 저장"');
                } else {
                    alert('💾 파일이 다운로드되었습니다!\n\n' +
                          '"다운로드" 또는 "파일" 앱에서 확인하세요.');
                }
            }, 500);
        } else {
            // 데스크탑
            setTimeout(() => URL.revokeObjectURL(url), 100);
        }
    }
}

// 앱 시작
let app;

async function waitForDriveReady(timeoutMs = 5000) {
    if (window.driveInitPromise) {
        return window.driveInitPromise;
    }

    return new Promise(resolve => {
        const interval = setInterval(() => {
            if (window.driveInitPromise) {
                clearInterval(interval);
                window.driveInitPromise.then(resolve).catch(resolve);
                return;
            }
        }, 100);

        setTimeout(() => {
            clearInterval(interval);
            resolve();
        }, timeoutMs);
    });
}

// Google Drive 준비 대기 후 앱 시작
async function startApp() {
    console.log('📱 앱 시작...');
    
    // Google Drive Manager가 준비될 때까지 대기 (최대 5초)
    let retries = 0;
    while (!window.driveManager && retries < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retries++;
    }
    
    if (window.driveManager) {
        console.log('✅ Google Drive Manager 준비됨');
    } else {
        console.warn('⚠️ Google Drive Manager 초기화 대기 시간 초과');
    }

    await waitForDriveReady();
    
    // 앱 인스턴스 생성
    app = new DxfPhotoEditor();
    window.app = app; // google-drive.js에서 접근 가능하도록 전역 노출
    console.log('✅ DXF Photo Editor 초기화 완료');

    // 목록 버튼으로 돌아온 경우 목록 화면 표시
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('backToList') === 'true') {
        console.log('📋 목록 화면으로 돌아오기');
        app.showFileList();
        // reload 파라미터 제거 (URL 정리)
        urlParams.delete('reload');
        urlParams.delete('backToList');
        const cleanUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
        window.history.replaceState({}, '', cleanUrl);
    }

    if (window.driveManager?.isAccessTokenValid()) {
        app.setLoginButtonState(true);
        await app.loadFileList();
    }
}

document.addEventListener('DOMContentLoaded', startApp);

