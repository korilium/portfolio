FROM julia:1.10

WORKDIR /app

COPY Project.toml Manifest.toml ./
RUN julia --project=. -e "using Pkg; Pkg.instantiate(); Pkg.precompile()"

COPY src/ src/

ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["julia", "--project=.", "src/server.jl"]
