package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"time"
)

// Answers 200 only when it can reach both of its dependencies by their compose names.
func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		for _, addr := range []string{os.Getenv("DB_ADDR"), os.Getenv("CACHE_ADDR")} {
			c, err := net.DialTimeout("tcp", addr, 2*time.Second)
			if err != nil {
				w.WriteHeader(503)
				fmt.Fprintf(w, "cannot reach %s: %v\n", addr, err)
				return
			}
			c.Close()
		}
		fmt.Fprintln(w, "api reached db and cache")
	})
	fmt.Println("api listening on :8080")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		panic(err)
	}
}
