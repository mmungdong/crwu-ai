package main

import (
	"os"

	"github.com/mmungdong/crwu-ai/internal/transport/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr))
}
