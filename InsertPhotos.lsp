;;; ====================================================================
;;; InsertPhotos.lsp - 최적화 버전 (entmake + vl-cmdf)
;;; 웹앱에서 작업한 사진과 메모를 AutoCAD 도면에 자동 삽입
;;; 
;;; 개선 사항:
;;;   1. SCR 파일 생성 제거 → 직접 엔티티 생성 (더 빠름)
;;;   2. entmake로 TEXT 엔티티 직접 생성
;;;   3. vl-cmdf로 IMAGE 명령 직접 실행
;;;   4. 사용자가 메타데이터 파일 직접 선택 가능
;;; ====================================================================

(defun C:INSERTPHOTOS (/ dwg-path dwg-name base-name json-file f line content
                         photo-count text-count i j fileName x y width height memo photo-path
                         insert-pt scale text-pt text-height dxf-y
                         texts-start texts-end texts-content
                         text-x text-y text-content text-fontsize text-dxf-y
                         selected-file use-default success-count fail-count
                         start-time end-time)
  
  ;; Visual LISP 함수 사용을 위한 초기화
  (vl-load-com)
  
  (princ "\n========================================")
  (princ "\n웹앱 사진/메모 자동 삽입 시작 (최적화 버전)")
  (princ "\n========================================\n")
  
  ;; 성능 측정 시작
  (setq start-time (getvar "MILLISECS"))
  
  ;; 현재 도면 경로
  (setq dwg-path (getvar "DWGPREFIX"))
  (setq dwg-name (getvar "DWGNAME"))
  (setq base-name (vl-filename-base dwg-name))
  
  (princ (strcat "\n현재 도면: " dwg-name))
  (princ (strcat "\n도면 경로: " dwg-path))
  
  ;; 메타데이터 파일 선택 (사용자 선택 또는 자동)
  (setq json-file (strcat dwg-path base-name "_metadata.json"))
  (setq use-default (findfile json-file))
  
  (if use-default
    (progn
      ;; 기본 파일이 있으면 사용할지 물어봄
      (princ (strcat "\n\n✅ 기본 메타데이터 파일 발견: " base-name "_metadata.json"))
      (initget "Yes No")
      (setq selected-file 
        (getkword (strcat "\n기본 파일 사용? [Yes/No] <Yes>: ")))
      (if (or (= selected-file nil) (= selected-file "Yes"))
        (setq json-file use-default)
        (progn
          ;; 사용자가 다른 파일 선택 (현재 도면 경로로 대화상자 열기)
          (setq json-file 
            (getfiled "메타데이터 JSON 파일 선택" 
                      (strcat dwg-path base-name "_metadata.json") 
                      "json" 
                      0))
          (if (= json-file nil)
            (progn
              (princ "\n❌ 파일 선택이 취소되었습니다.")
              (princ)
              (exit)
            )
          )
        )
      )
    )
    (progn
      ;; 기본 파일이 없으면 파일 선택 대화상자 표시 (현재 도면 경로로 대화상자 열기)
      (princ (strcat "\n\n⚠️ 기본 메타데이터 파일을 찾을 수 없습니다: " base-name "_metadata.json"))
      (setq json-file 
        (getfiled "메타데이터 JSON 파일 선택" 
                  (strcat dwg-path base-name "_metadata.json") 
                  "json" 
                  0))
      (if (= json-file nil)
        (progn
          (princ "\n❌ 파일 선택이 취소되었습니다.")
          (princ)
          (exit)
        )
      )
    )
  )
  
  (princ (strcat "\n📄 선택된 메타데이터 파일: " (vl-filename-base json-file) "." (vl-filename-extension json-file)))
  
  (if (not (findfile json-file))
    (progn
      (princ (strcat "\n\n❌ 메타데이터 파일을 찾을 수 없습니다:"))
      (princ (strcat "\n   " json-file))
    )
    (progn
      (princ (strcat "\n✅ 메타데이터 파일 로드 완료"))
      
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
              (princ "\n\n🚀 직접 삽입 시작 (최적화 모드)...\n")
              
              ;; 성공/실패 카운터 초기화
              (setq success-count 0)
              (setq fail-count 0)
              
              ;; 각 사진 처리 (직접 삽입)
              (if (> photo-count 0)
                (progn
                  (princ "\n📸 사진 삽입 중...\n")
                  (setq i 0)
                  (while (< i photo-count)
                    (princ (strcat "\r   진행: [" (itoa (+ i 1)) "/" (itoa photo-count) "] "))
                    
                    ;; JSON에서 값 추출
                    (setq fileName (get-json-value content "fileName" i))
                    (setq x (atof (get-json-value content "\"x\"" i)))
                    (setq y (atof (get-json-value content "\"y\"" i)))
                    (setq width (atof (get-json-value content "\"width\"" i)))
                    (setq height (atof (get-json-value content "\"height\"" i)))
                    (setq memo (get-json-value content "memo" i))
                    
                    ;; Y축 좌표 역변환
                    (setq dxf-y (- y))
                    
                    ;; 파일 경로 찾기 (메타데이터 파일 폴더 우선, 없으면 도면 폴더)
                    (setq photo-path (strcat (vl-filename-directory json-file) "\\" fileName))
                    (if (not (findfile photo-path))
                      (setq photo-path (strcat dwg-path fileName))
                    )
                    
                    (if (not (findfile photo-path))
                      (progn
                        (princ (strcat "\n       ⚠️ 파일 없음: " fileName))
                        (setq fail-count (+ fail-count 1))
                      )
                      (progn
                        ;; 사진 축척 고정: 0.3
                        (setq scale 0.3)
                        (setq text-height 1.0)
                        
                        ;; IMAGE 명령 직접 실행 (vl-cmdf 사용 - 더 빠름)
                        (if (vl-catch-all-error-p
                              (vl-catch-all-apply
                                'vl-cmdf
                                (list "._-IMAGE" "_A" photo-path (strcat (rtos x 2 6) "," (rtos dxf-y 2 6)) (rtos scale 2 6) "0")
                              )
                            )
                          (progn
                            (princ (strcat "\n       ❌ 이미지 삽입 실패: " fileName))
                            (setq fail-count (+ fail-count 1))
                          )
                          (progn
                            ;; 메모 텍스트 추가 (entmake로 직접 생성 - 더 빠름)
                            (if (and memo 
                                     (> (strlen memo) 0) 
                                     (/= memo "")
                                     (/= (vl-string-trim " \t\n\r" memo) ""))
                              (progn
                                ;; entmake로 TEXT 엔티티 직접 생성
                                (entmake (list
                                  '(0 . "TEXT")
                                  (cons 10 (list x dxf-y 0.0))  ; 삽입점
                                  (cons 40 text-height)         ; 높이
                                  (cons 1 memo)                 ; 텍스트 내용
                                  (cons 50 0.0)                 ; 회전각
                                  (cons 7 (getvar "TEXTSTYLE")) ; 텍스트 스타일
                                ))
                              )
                            )
                            (setq success-count (+ success-count 1))
                          )
                        )
                      )
                    )
                    
                    (setq i (+ i 1))
                  )
                  (princ "\n")
                )
              )
              
              ;; 독립 텍스트 처리 (entmake로 직접 생성)
              (if (> text-count 0)
                (progn
                  (princ "\n📝 독립 텍스트 삽입 중...\n")
                  
                  (setq j 0)
                  (while (< j text-count)
                    (princ (strcat "\r   진행: [" (itoa (+ j 1)) "/" (itoa text-count) "] "))
                    
                    ;; JSON에서 값 추출 (texts 배열 인덱스로)
                    (setq text-x (atof (get-json-value-from-texts content "\"x\"" j)))
                    (setq text-y (atof (get-json-value-from-texts content "\"y\"" j)))
                    (setq text-content (get-json-value-from-texts content "\"text\"" j))
                    (setq text-fontsize (atof (get-json-value-from-texts content "\"fontSize\"" j)))
                    
                    ;; Y축 좌표 역변환
                    (setq text-dxf-y (- text-y))
                    
                    ;; entmake로 TEXT 엔티티 직접 생성 (더 빠름)
                    (entmake (list
                      '(0 . "TEXT")
                      (cons 10 (list text-x text-dxf-y 0.0))  ; 삽입점
                      (cons 40 1.0)                           ; 높이 1.0 고정
                      (cons 1 text-content)                   ; 텍스트 내용
                      (cons 50 0.0)                           ; 회전각
                      (cons 7 (getvar "TEXTSTYLE"))           ; 텍스트 스타일
                    ))
                    
                    (setq success-count (+ success-count 1))
                    (setq j (+ j 1))
                  )
                  (princ "\n")
                )
              )
              
              ;; 결과 요약
              (princ "\n\n========================================")
              (princ "\n✅ 삽입 완료!")
              (princ (strcat "\n   성공: " (itoa success-count) "개"))
              (if (> fail-count 0)
                (princ (strcat "\n   실패: " (itoa fail-count) "개"))
              )
              
              ;; 성능 측정 종료
              (setq end-time (getvar "MILLISECS"))
              (princ (strcat "\n   소요 시간: " (itoa (- end-time start-time)) "ms"))
              (princ "\n========================================")
            )
            (princ "\n   사진과 텍스트 없음")
          )
          
          (if (or (> photo-count 0) (> text-count 0))
            (princ "\n")
            (progn
              (princ "\n\n========================================")
              (princ "\n✅ 작업 완료!")
              (princ "\n========================================\n")
            )
          )
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
(princ "\n✅ InsertPhotos.lsp 로드 완료 (최적화 버전)")
(princ "\n========================================")
(princ "\n명령어: INSERTPHOTOS")
(princ "\n")
(princ "\n개선 사항:")
(princ "\n  - SCR 파일 생성 제거 → 직접 엔티티 생성 (더 빠름)")
(princ "\n  - entmake로 TEXT 엔티티 직접 생성")
(princ "\n  - vl-cmdf로 IMAGE 명령 직접 실행")
(princ "\n  - 사용자가 메타데이터 파일 직접 선택 가능")
(princ "\n========================================\n")
(princ)
