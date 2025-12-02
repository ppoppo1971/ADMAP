/**
 * ========================================
 * DMAP - 라이브러리 복사 스크립트
 * ========================================
 * 
 * 용도:
 *   - npm 패키지에서 필요한 라이브러리를 libs 폴더로 복사
 *   - GitHub Pages 배포를 위한 로컬 파일 준비
 *   - CDN 폴백을 위한 로컬 파일 제공
 * 
 * 실행:
 *   npm run copy-libs
 *   또는
 *   npm run setup (install + copy-libs)
 * 
 * 복사 대상:
 *   - dxf-parser: DXF 파일 파싱 라이브러리
 *     (node_modules/dxf-parser/dist/dxf-parser.min.js → libs/dxf-parser.min.js)
 * 
 * 배포:
 *   - libs 폴더를 GitHub에 커밋
 *   - index.html에서 로컬 파일 우선 사용, CDN은 폴백
 * 
 * 버전: 1.0.0
 * 최종 수정: 2025-11-18
 * ========================================
 */

const fs = require('fs');
const path = require('path');

// libs 폴더 생성
const libsDir = path.join(__dirname, 'libs');
if (!fs.existsSync(libsDir)) {
    fs.mkdirSync(libsDir);
    console.log('✅ libs 폴더 생성');
}

// 파일 복사 함수
function copyFile(source, dest) {
    try {
        fs.copyFileSync(source, dest);
        console.log(`✅ 복사 완료: ${path.basename(dest)}`);
        return true;
    } catch (error) {
        console.error(`❌ 복사 실패: ${path.basename(dest)}`, error.message);
        return false;
    }
}

// dxf-parser 복사
const dxfParserSource = path.join(__dirname, 'node_modules', 'dxf-parser', 'dist', 'dxf-parser.min.js');
const dxfParserDest = path.join(libsDir, 'dxf-parser.min.js');

console.log('\n📦 라이브러리 복사 시작...\n');

let success = copyFile(dxfParserSource, dxfParserDest);

if (success) {
    console.log('\n✅ 모든 라이브러리 복사 완료!');
    console.log('\n다음 단계:');
    console.log('1. libs 폴더를 GitHub에 커밋');
    console.log('2. index.html에서 CDN 대신 로컬 파일 사용');
    console.log('3. GitHub Pages에 배포');
} else {
    console.log('\n⚠️ 일부 파일 복사 실패. node_modules가 설치되었는지 확인하세요.');
    console.log('npm install 을 먼저 실행하세요.');
}

