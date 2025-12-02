;;; ====================================================================
;;; InsertPhotos.lsp - SCR 파일 생성 방식
;;; ====================================================================
;;; 
;;; 용도:
;;;   - 웹앱(DMAP)에서 작업한 사진과 메모를 AutoCAD 도면에 자동 삽입
;;;   - 메타데이터 JSON 파일을 읽어 SCR 스크립트 생성 및 실행
;;; 
;;; 사용 방법:
;;;   1. 웹앱에서 도면 작업 후 Google Drive에 저장
;;;   2. 메타데이터 JSON 파일과 사진 파일들을 다운로드
;;;   3. AutoCAD에서 동일한 DXF 파일 열기
;;;   4. INSERTPHOTOS 명령어 실행
;;;   5. 자동으로 사진과 텍스트가 삽입됨
;;; 
;;; 처리 내용:
;;;   - {파일명}_metadata.json 파일 읽기
;;;   - 사진 파일들을 IMAGE ATTACH 명령으로 삽입 (스케일 0.3 고정)
;;;   - 사진 메모를 TEXT 명령으로 삽입 (높이 1.0 고정)
;;;   - 독립 텍스트를 TEXT 명령으로 삽입 (높이 1.0 고정)
;;;   - SCR 파일 생성 후 자동 실행
;;; 
;;; 좌표 변환:
;;;   - 웹앱 좌표 (Y축 정방향) → AutoCAD 좌표 (Y축 역방향)
;;;   - Y 좌표에 -1을 곱하여 변환
;;; 
;;; 버전: 1.0.0
;;; 최종 수정: 2025-11-18
;;; ====================================================================

(defun C:INSERTPHOTOS (/ dwg-path dwg-name base-name json-file f line content
                         photo-count text-count i j fileName x y width height memo photo-path
                         insert-pt scale text-pt text-height dxf-y scr-file scr-content
                         texts-start texts-end texts-content
                         text-x text-y text-content text-fontsize text-dxf-y)
  
  (princ "\n========================================")
  (princ "\n웹앱 사진/메모 자동 삽입 시작")
  (princ "\n========================================\n")
  
  ;; 현재 도면 경로
  (setq dwg-path (getvar "DWGPREFIX"))
  (setq dwg-name (getvar "DWGNAME"))
  (setq base-name (vl-filename-base dwg-name))
  
  (princ (strcat "\n현재 도면: " dwg-name))
  (princ (strcat "\n도면 경로: " dwg-path))
  
  ;; 메타데이터 파일
  (setq json-file (strcat dwg-path base-name "_metadata.json"))
  
  (if (not (findfile json-file))
    (progn
      (princ (strcat "\n\n❌ 메타데이터 파일을 찾을 수 없습니다:"))
      (princ (strcat "\n   " json-file))
    )
    (progn
      (princ (strcat "\n✅ 메타데이터 발견: " base-name "_metadata.json"))
      
      ;; 파일 읽기
      (setq content "")
      (setq f (open json-file "r"))
      (if f
        (progn
          (while (setq line (read-line f))
            (setq content (strcat content line "\n"))
          )
          (close f)
          
          ;; 사진 개수 계산
          (setq photo-count (count-occurrences "\"fileName\"" content))
          
          ;; 텍스트 개수 계산 (texts 배열 내 id 개수로 추정)
          (setq texts-start (vl-string-search "\"texts\":" content))
          (if texts-start
            (progn
              (setq texts-start (vl-string-search "[" content texts-start))
              (setq texts-end (vl-string-search "]" content texts-start))
              (setq texts-content (substr content (1+ texts-start) (- texts-end texts-start)))
              (setq text-count (count-occurrences "\"id\"" texts-content))
            )
            (setq text-count 0)
          )
          
          (princ (strcat "\n\n📊 발견된 항목:"))
          (princ (strcat "\n   사진: " (itoa photo-count) "개"))
          (princ (strcat "\n   텍스트: " (itoa text-count) "개"))
          
          (if (or (> photo-count 0) (> text-count 0))
            (progn
              (princ "\n\n📝 SCR 스크립트 생성 중...\n")
              
              ;; SCR 파일 내용 생성
              (setq scr-content "")
              
              ;; 각 사진 처리
              (if (> photo-count 0)
                (progn
                  (princ "\n📸 사진 삽입...\n")
                  (setq i 0)
                  (while (< i photo-count)
                (princ (strcat "\n   [" (itoa (+ i 1)) "/" (itoa photo-count) "] "))
                
                ;; JSON에서 값 추출
                (setq fileName (get-json-value content "fileName" i))
                (setq x (atof (get-json-value content "\"x\"" i)))
                (setq y (atof (get-json-value content "\"y\"" i)))
                (setq width (atof (get-json-value content "\"width\"" i)))
                (setq height (atof (get-json-value content "\"height\"" i)))
                (setq memo (get-json-value content "memo" i))
                
                (princ fileName)
                
                ;; Y축 좌표 역변환
                (setq dxf-y (- y))
                (princ (strcat "\n       DXF 좌표: (" (rtos x 2 2) ", " (rtos dxf-y 2 2) ")"))
                
                ;; 파일 경로
                (setq photo-path (strcat dwg-path fileName))
                
                (if (not (findfile photo-path))
                  (princ (strcat "\n       ⚠️ 파일 없음: " fileName))
                  (progn
                    ;; 사진 축척 고정: 0.3
                    (setq scale 0.3)
                    
                    ;; 텍스트 높이 고정: 1
                    (setq text-height 1.0)
                    
                    (princ (strcat "\n       사진 스케일: " (rtos scale 2 2)))
                    (princ (strcat "\n       텍스트 높이: " (rtos text-height 2 2)))
                    
                    ;; SCR 명령 추가 - IMAGE ATTACH (AutoCAD 2024 호환)
                    (setq scr-content 
                      (strcat scr-content
                              "-IMAGE\n"
                              "A\n"
                              photo-path "\n"
                              (rtos x 2 6) "," (rtos dxf-y 2 6) "\n"
                              "0.3\n"  ; 스케일 고정값 0.3
                              "0\n"  ; 회전각 0
                      )
                    )
                    
                    ;; 메모 텍스트 SCR 명령 추가 (동일한 좌표)
                    ;; 메모가 비어있지 않을 때만 추가
                    (if (and memo 
                             (> (strlen memo) 0) 
                             (/= memo "")
                             (/= (vl-string-trim " \t\n\r" memo) ""))
                      (progn
                        (princ (strcat "\n       메모: " memo " (동일 좌표)"))
                        
                        ;; IMAGE 완료 후 바로 TEXT 명령 (빈 줄 없음)
                        (setq scr-content
                          (strcat scr-content
                                  "TEXT\n"
                                  (rtos x 2 6) "," (rtos dxf-y 2 6) "\n"
                                  "1\n"  ; 텍스트 높이 고정값 1
                                  "0\n"  ; 회전각 0
                                  memo "\n"  ; 텍스트 내용
                          )
                        )
                      )
                      (princ "\n       메모: (없음)")
                    )
                    
                    (princ "\n       ✅ SCR에 추가됨")
                  )
                )
                
                    (setq i (+ i 1))
                  )
                )
              )
              
              ;; 독립 텍스트 처리
              (if (> text-count 0)
                (progn
                  (princ "\n\n📝 독립 텍스트 삽입 중...\n")
                  
                  (setq j 0)
                  (while (< j text-count)
                    (princ (strcat "\n   [" (itoa (+ j 1)) "/" (itoa text-count) "] "))
                    
                    ;; JSON에서 값 추출 (texts 배열 인덱스로)
                    (setq text-x (atof (get-json-value-from-texts content "\"x\"" j)))
                    (setq text-y (atof (get-json-value-from-texts content "\"y\"" j)))
                    (setq text-content (get-json-value-from-texts content "\"text\"" j))
                    (setq text-fontsize (atof (get-json-value-from-texts content "\"fontSize\"" j)))
                    
                    ;; Y축 좌표 역변환
                    (setq text-dxf-y (- text-y))
                    
                    (princ (strcat "\"" text-content "\""))
                    (princ (strcat "\n       DXF 좌표: (" (rtos text-x 2 2) ", " (rtos text-dxf-y 2 2) ")"))
                    (princ (strcat "\n       폰트 크기: " (rtos text-fontsize 2 2)))
                    
                    ;; SCR에 TEXT 명령 추가 (크기 1.0 고정)
                    (setq scr-content
                      (strcat scr-content
                              "TEXT\n"
                              (rtos text-x 2 6) "," (rtos text-dxf-y 2 6) "\n"
                              "1.0\n"  ; 텍스트 높이 1.0 고정
                              "0\n"  ; 회전각 0
                              text-content "\n"  ; 텍스트 내용
                      )
                    )
                    
                    (princ "\n       ✅ SCR에 추가됨")
                    (setq j (+ j 1))
                  )
                )
              )
              
              ;; SCR 파일 저장
              (if (> (strlen scr-content) 0)
                (progn
                  (setq scr-file (strcat dwg-path base-name "_insert.scr"))
                  (setq f (open scr-file "w"))
                  (if f
                    (progn
                      ;; princ 사용 (write-line은 줄바꿈 문제 발생)
                      (princ scr-content f)
                      (close f)
                      
                      (princ (strcat "\n\n✅ SCR 파일 생성 완료: " base-name "_insert.scr"))
                      (princ "\n\n📸 이미지 삽입 실행 중...")
                      
                      ;; SCR 파일 실행
                      (command "._SCRIPT" scr-file)
                      
                      (princ "\n✅ 스크립트 실행 완료!")
                    )
                    (princ "\n❌ SCR 파일 생성 실패")
                  )
                )
                (princ "\n⚠️ 삽입할 항목 없음")
              )
            )
            (princ "\n   사진과 텍스트 없음")
          )
          
          (princ "\n\n========================================")
          (princ "\n✅ 작업 완료!")
          (princ "\n========================================\n")
        )
        (princ "\n❌ 메타데이터 파일을 열 수 없습니다")
      )
    )
  )
  
  (princ)
)

;;; ====================================================================
;;; 보조 함수
;;; ====================================================================

;; 문자열에서 부분문자열 개수 세기
(defun count-occurrences (search-str in-str / count pos)
  (setq count 0)
  (setq pos 1)
  (while (setq pos (vl-string-search search-str in-str (1- pos)))
    (setq count (1+ count))
    (setq pos (+ pos (strlen search-str) 1))
  )
  count
)

;; texts 배열에서 N번째 항목의 키 값 추출
(defun get-json-value-from-texts (json-str key occurrence / texts-start texts-end texts-content)
  ;; "texts": [ ... ] 부분 찾기
  (setq texts-start (vl-string-search "\"texts\":" json-str))
  (if texts-start
    (progn
      ;; texts 배열 시작 찾기
      (setq texts-start (vl-string-search "[" json-str texts-start))
      ;; texts 배열 끝 찾기 (간단하게 처리)
      (setq texts-end (vl-string-search "]" json-str texts-start))
      ;; texts 배열 내용 추출
      (setq texts-content (substr json-str (1+ texts-start) (- texts-end texts-start)))
      ;; texts 내용에서 N번째 키 값 추출
      (get-json-value texts-content key occurrence)
    )
    "" ; texts 배열이 없으면 빈 문자열
  )
)

;; JSON에서 N번째 키의 값 추출
(defun get-json-value (json-str key occurrence / pos count start-pos end-pos value)
  (setq count 0)
  (setq pos 0)
  (setq value "")
  
  ;; N번째 키 위치 찾기
  (while (and (<= count occurrence) (< pos (strlen json-str)))
    (setq pos (vl-string-search key json-str pos))
    (if pos
      (progn
        (if (= count occurrence)
          (progn
            ;; 키 다음의 : 찾기
            (setq start-pos (vl-string-search ":" json-str pos))
            (if start-pos
              (progn
                (setq start-pos (1+ start-pos))
                
                ;; 공백 건너뛰기
                (while (and (< start-pos (strlen json-str))
                            (member (substr json-str (1+ start-pos) 1) '(" " "\t" "\n" "\r")))
                  (setq start-pos (1+ start-pos))
                )
                
                (setq start-pos (1+ start-pos))
                
                ;; 값 타입 확인
                (cond
                  ;; 문자열 값
                  ((= (substr json-str start-pos 1) "\"")
                   (setq end-pos (vl-string-search "\"" json-str start-pos))
                   (if end-pos
                     (setq value (substr json-str (1+ start-pos) (- end-pos start-pos)))
                     (setq value "")
                   )
                  )
                  
                  ;; 숫자 값
                  ((or (wcmatch (substr json-str start-pos 1) "0123456789.-+"))
                   (setq end-pos start-pos)
                   (while (and (< end-pos (strlen json-str))
                               (wcmatch (substr json-str (1+ end-pos) 1) "0123456789.-+eE"))
                     (setq end-pos (1+ end-pos))
                   )
                   (setq value (substr json-str start-pos (1+ (- end-pos start-pos))))
                  )
                  
                  ;; 기타
                  (t
                   (setq end-pos (vl-string-search "," json-str start-pos))
                   (if (not end-pos)
                     (setq end-pos (vl-string-search "}" json-str start-pos))
                   )
                   (if end-pos
                     (setq value (substr json-str start-pos (1+ (- end-pos start-pos))))
                     (setq value "")
                   )
                  )
                )
              )
            )
          )
        )
        (setq count (1+ count))
        (setq pos (+ pos (strlen key)))
      )
      (setq pos (strlen json-str))
    )
  )
  
  ;; 값 정리
  (while (and (> (strlen value) 0)
              (member (substr value 1 1) '(" " "\t" "\n" "\r" "\"" "'")))
    (setq value (substr value 2))
  )
  (while (and (> (strlen value) 0)
              (member (substr value (strlen value) 1) '(" " "\t" "\n" "\r" "," "\"" "'")))
    (setq value (substr value 1 (1- (strlen value))))
  )
  
  value
)

;;; ====================================================================
;;; 스크립트 로드 완료
;;; ====================================================================

(princ "\n========================================")
(princ "\n✅ InsertPhotos.lsp 로드 완료")
(princ "\n========================================")
(princ "\n명령어: INSERTPHOTOS")
(princ "\n========================================\n")
(princ)
