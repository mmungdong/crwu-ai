package main

import (
	"os"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunops"
	"github.com/mmungdong/crwu-ai/internal/app/h3yunweb"
	"github.com/mmungdong/crwu-ai/internal/transport/cli"
)

func main() {
	os.Exit(cli.RunWithDependencies(os.Args[1:], os.Stdout, os.Stderr, cli.Dependencies{
		H3YunOps: h3yunops.EnvService(os.Getenv),
		H3YunWeb: h3yunweb.EnvService(os.Getenv),
		Getenv:   os.Getenv,
	}))
}
