FROM julia:1.10

WORKDIR /app

COPY Project.toml Manifest.toml ./
RUN julia --project=. -e "using Pkg; Pkg.instantiate(); Pkg.precompile()"

COPY src/ src/

ENV HOST=0.0.0.0
EXPOSE 8080

# threads: /dynpro/sweep runs its 32 solves in parallel. The ",1" adds an
# INTERACTIVE thread, which is thread 1 and hosts the server loop; @spawn'd solves
# go to the default pool and so can never block the server from accepting.
CMD ["julia", "--project=.", "--threads=auto,1", "src/server.jl"]
