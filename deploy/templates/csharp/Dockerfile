# syntax=docker/dockerfile:1
# Set PROJECT to your csproj path and DLL name to the published assembly.
ARG PROJECT=src/YourApp.Api/YourApp.Api.csproj
ARG DLL=YourApp.Api.dll

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
ARG PROJECT
WORKDIR /src
COPY . .
RUN dotnet restore "${PROJECT}"
RUN dotnet publish "${PROJECT}" -c Release -o /app/publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runner
ARG DLL
WORKDIR /app
RUN groupadd -r app && useradd -r -g app app \
  && apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=app:app /app/publish .
USER app
ENV ASPNETCORE_URLS=http://+:8080
ENV DLL=${DLL}
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["sh", "-c", "dotnet \"$DLL\""]
