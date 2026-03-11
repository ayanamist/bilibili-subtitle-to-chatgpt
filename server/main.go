package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/BurntSushi/toml"
)

// ---- 配置 ----

// ExecConfig 支持 string 或 []string 两种格式
type ExecConfig struct {
	Parts []string // 解析后的命令部分，Parts[0] 为程序路径，其余为参数
}

func (e *ExecConfig) UnmarshalTOML(data interface{}) error {
	switch v := data.(type) {
	case string:
		// 按 shell 规则拆分（支持引号）
		parts, err := shellSplit(v)
		if err != nil {
			return fmt.Errorf("exec 字符串解析失败: %w", err)
		}
		if len(parts) == 0 {
			return fmt.Errorf("exec 不能为空字符串")
		}
		e.Parts = parts
		return nil
	case []interface{}:
		if len(v) == 0 {
			return fmt.Errorf("exec 数组不能为空")
		}
		parts := make([]string, 0, len(v))
		for i, item := range v {
			s, ok := item.(string)
			if !ok {
				return fmt.Errorf("exec 数组第 %d 个元素不是字符串", i)
			}
			parts = append(parts, s)
		}
		e.Parts = parts
		return nil
	default:
		return fmt.Errorf("exec 必须是字符串或字符串数组")
	}
}

// shellSplit 按 shell 规则拆分字符串（支持单引号、双引号和反斜杠转义）
func shellSplit(s string) ([]string, error) {
	var parts []string
	var current strings.Builder
	inSingle := false
	inDouble := false
	escaped := false

	for _, r := range s {
		if escaped {
			current.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' && !inSingle {
			escaped = true
			continue
		}
		if r == '\'' && !inDouble {
			inSingle = !inSingle
			continue
		}
		if r == '"' && !inSingle {
			inDouble = !inDouble
			continue
		}
		if unicode.IsSpace(r) && !inSingle && !inDouble {
			if current.Len() > 0 {
				parts = append(parts, current.String())
				current.Reset()
			}
			continue
		}
		current.WriteRune(r)
	}
	if inSingle {
		return nil, fmt.Errorf("未闭合的单引号")
	}
	if inDouble {
		return nil, fmt.Errorf("未闭合的双引号")
	}
	if current.Len() > 0 {
		parts = append(parts, current.String())
	}
	return parts, nil
}

type Config struct {
	Addr            string     `toml:"addr"`
	Token           string     `toml:"token"`
	Exec            ExecConfig `toml:"exec"`
	AllowExtensions []string   `toml:"allow_extensions"`
	Cwd             string     `toml:"cwd"`
}

func loadConfig(path string) (*Config, error) {
	cfg := &Config{
		Addr: ":8080",
	}
	if _, err := toml.DecodeFile(path, cfg); err != nil {
		return nil, fmt.Errorf("读取配置文件失败: %w", err)
	}
	if cfg.Token == "" {
		return nil, fmt.Errorf("配置文件中 token 不能为空")
	}
	if len(cfg.Exec.Parts) == 0 {
		return nil, fmt.Errorf("配置文件中 exec 不能为空")
	}
	if len(cfg.AllowExtensions) == 0 {
		cfg.AllowExtensions = []string{"m4a", "m4s"}
	}
	return cfg, nil
}

// ---- SSE 辅助 ----

type sseWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func newSSEWriter(w http.ResponseWriter) (*sseWriter, bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	return &sseWriter{w: w, flusher: flusher}, true
}

func (s *sseWriter) writeEvent(event, data string) {
	fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, data)
	s.flusher.Flush()
}

func (s *sseWriter) writeError(msg string) {
	payload, _ := json.Marshal(map[string]string{"error": msg})
	s.writeEvent("error", string(payload))
}

// ---- 排队机制 ----

type queueManager struct {
	mu      sync.Mutex
	waiters []*waiter
	sem     chan struct{} // 容量为1，控制并发
}

type waiter struct {
	id     string
	notify chan int // 发送排队位置更新，-1 表示轮到执行
	done   chan struct{}
}

var globalQueue = &queueManager{
	sem: make(chan struct{}, 1),
}

// release 释放执行权并从队列移除
func (q *queueManager) release(id string) {
	q.remove(id)
	select {
	case <-q.sem:
	default:
	}
	q.broadcastPositions()
}

func (q *queueManager) remove(id string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, w := range q.waiters {
		if w.id == id {
			q.waiters = append(q.waiters[:i], q.waiters[i+1:]...)
			return
		}
	}
}

func (q *queueManager) broadcastPositions() {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, w := range q.waiters {
		select {
		case w.notify <- i:
		default:
		}
	}
}

// ---- 鉴权中间件 ----

func authMiddleware(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		provided := strings.TrimPrefix(authHeader, "Bearer ")
		if provided != token {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

// ---- /version 接口 ----

const serviceVersion = "1.0.0"

func versionHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"version": serviceVersion})
}

// ---- /transcribe 接口 ----

type transcribeRequest struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

func makeTranscribeHandler(cfg *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}

		// 解析请求体
		var req transcribeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "请求体解析失败: "+err.Error(), http.StatusBadRequest)
			return
		}

		// 校验 URL 后缀
		urlPath := strings.Split(req.URL, "?")[0]
		urlPathLower := strings.ToLower(urlPath)
		var matchedExt string
		for _, ext := range cfg.AllowExtensions {
			dotExt := "." + strings.ToLower(strings.TrimPrefix(ext, "."))
			if strings.HasSuffix(urlPathLower, dotExt) {
				matchedExt = dotExt
				break
			}
		}
		if matchedExt == "" {
			actualExt := strings.TrimPrefix(filepath.Ext(urlPath), ".")
			if actualExt == "" {
				actualExt = "(无扩展名)"
			}
			http.Error(w, "收到的扩展名 "+actualExt+" 不在允许列表中，仅支持: "+strings.Join(cfg.AllowExtensions, ", "), http.StatusBadRequest)
			return
		}

		// 建立 SSE 连接
		sse, ok := newSSEWriter(w)
		if !ok {
			http.Error(w, "不支持 SSE", http.StatusInternalServerError)
			return
		}

		ctx := r.Context()

		// 排队
		waiterID := fmt.Sprintf("%d", time.Now().UnixNano())
		w2 := &waiter{
			id:     waiterID,
			notify: make(chan int, 10),
			done:   make(chan struct{}),
		}

		globalQueue.mu.Lock()
		globalQueue.waiters = append(globalQueue.waiters, w2)
		globalQueue.mu.Unlock()
		globalQueue.broadcastPositions()

		acquired := false
		defer func() {
			if acquired {
				globalQueue.release(waiterID)
			} else {
				globalQueue.remove(waiterID)
				globalQueue.broadcastPositions()
			}
			close(w2.done)
		}()

		// 等待排队
	waitLoop:
		for {
			select {
			case <-ctx.Done():
				return
			case pos := <-w2.notify:
				if pos == 0 {
					// 尝试获取 semaphore
					select {
					case globalQueue.sem <- struct{}{}:
						acquired = true
						break waitLoop
					case <-ctx.Done():
						return
					}
				}
				payload, _ := json.Marshal(map[string]int{"position": pos})
				sse.writeEvent("queue", string(payload))
			}
		}

		// 通知客户端开始转换
		sse.writeEvent("converting", `{"status":"started"}`)

		// 下载音频文件
		tmpDir := os.TempDir()
		tmpFile, err := os.CreateTemp(tmpDir, "bilibili-audio-*"+matchedExt)
		if err != nil {
			sse.writeError("创建临时文件失败: " + err.Error())
			return
		}
		audioPath := tmpFile.Name()
		tmpFile.Close()

		srtPath := strings.TrimSuffix(audioPath, matchedExt) + ".srt"
		logPath := strings.TrimSuffix(audioPath, matchedExt) + ".log"

		// defer 清理文件
		defer func() {
			os.Remove(audioPath)
			os.Remove(srtPath)
			os.Remove(logPath)
		}()

		// 下载音频
		if err := downloadFile(ctx, req.URL, req.Headers, audioPath); err != nil {
			sse.writeError("音频下载失败: " + err.Error())
			return
		}

		// 调用转写程序
		cmdParts := append(append([]string{}, cfg.Exec.Parts...), audioPath)
		cmdCtx, cmdCancel := context.WithCancel(ctx)
		defer cmdCancel()

		cmd := exec.CommandContext(cmdCtx, cmdParts[0], cmdParts[1:]...)
		if cfg.Cwd != "" {
			cmd.Dir = cfg.Cwd
		}

		// 将输出重定向到日志文件，避免管道导致的编码问题
		outFile, err := os.Create(logPath)
		if err != nil {
			sse.writeError("创建输出日志文件失败: " + err.Error())
			return
		}
		cmd.Stdout = outFile
		cmd.Stderr = outFile

		if err := cmd.Start(); err != nil {
			outFile.Close()
			sse.writeError("启动转写程序失败: " + err.Error())
			return
		}

		// 心跳 goroutine
		heartbeatDone := make(chan struct{})
		go func() {
			defer close(heartbeatDone)
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-cmdCtx.Done():
					return
				case <-ticker.C:
					sse.writeEvent("converting", `{"status":"running"}`)
				}
			}
		}()

		// 等待转写完成
		waitErr := cmd.Wait()
		outFile.Close()
		cmdCancel()
		<-heartbeatDone

		if ctx.Err() != nil {
			// 客户端已断开
			return
		}

		if waitErr != nil {
			payload, _ := json.Marshal(map[string]string{
				"error":  "转写程序执行失败: " + waitErr.Error(),
				"output": readLastLines(logPath, 50),
			})
			sse.writeEvent("error", string(payload))
			return
		}

		// 读取 SRT 文件
		srtContent, err := os.ReadFile(srtPath)
		if err != nil {
			payload, _ := json.Marshal(map[string]string{
				"error":  "读取 SRT 文件失败: " + err.Error(),
				"output": readLastLines(logPath, 50),
			})
			sse.writeEvent("error", string(payload))
			return
		}

		// 返回结果
		payload, _ := json.Marshal(map[string]string{"srt": string(srtContent)})
		sse.writeEvent("result", string(payload))
	}
}

// readLastLines 读取文件最后 n 行内容
func readLastLines(path string, n int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// downloadFile 使用指定 headers 下载文件到 destPath
func downloadFile(ctx context.Context, url string, headers map[string]string, destPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	f, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = io.Copy(f, resp.Body)
	return err
}

// ---- 主函数 ----

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintf(os.Stderr, "用法: %s <config.toml>\n", filepath.Base(os.Args[0]))
		os.Exit(1)
	}

	cfg, err := loadConfig(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "配置错误: %v\n", err)
		os.Exit(1)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/version", authMiddleware(cfg.Token, versionHandler))
	mux.HandleFunc("/transcribe", authMiddleware(cfg.Token, makeTranscribeHandler(cfg)))

	log.Printf("服务启动，监听地址: %s", cfg.Addr)
	if err := http.ListenAndServe(cfg.Addr, mux); err != nil {
		fmt.Fprintf(os.Stderr, "服务启动失败: %v\n", err)
		os.Exit(1)
	}
}