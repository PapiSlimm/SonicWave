@echo off
setlocal
REM ============================================================
REM  SONICWAVE LAUNCH SCRIPT - builds in Google Cloud and deploys
REM  to Cloud Run (same home as SonicStream, no Render limits).
REM  Run FROM INSIDE the SonicWave folder:
REM    cd "C:\Users\Ron Dixon\Desktop\SonicWave"
REM    deploy-sonicwave.cmd
REM ============================================================
set PROJECT=gen-lang-client-0237733980
set REGION=us-east1
set IMAGE=us-east1-docker.pkg.dev/%PROJECT%/sonicstream/sonicwave:v1
set SQLCONN=%PROJECT%:us-east1:sonicstream-pg
set SECRETS=DATABASE_URL=sonicwave-db:latest,REDIS_URL=sonicstream-redis:latest,STRIPE_SECRET_KEY=sonicstream-stripe:latest,STRIPE_WEBHOOK_SECRET=sonicstream-stripe-webhook:latest,MINIMAX_API_KEY=sonicstream-minimax:latest
set ENVS=NODE_ENV=production,STORAGE_BUCKET=sonicwave-exports,CORS_ORIGINS=https://sonicwave-649165523634.us-east1.run.app,FIREBASE_PROJECT_ID=%PROJECT%

echo.
echo  === STEP 0: sanity check ===
if not exist Dockerfile (
  echo  ERROR: Dockerfile not found. Run this from inside the SonicWave folder:
  echo    cd "C:\Users\Ron Dixon\Desktop\SonicWave"
  pause & exit /b 1
)
echo  OK - running from the right folder.

echo.
echo  === STEP 1: building SonicWave in Google Cloud (5-15 min) ===
call gcloud builds submit --tag %IMAGE% --timeout=1500 .
if errorlevel 1 ( echo BUILD FAILED - copy the red text above to Claude. & pause & exit /b 1 )

echo.
echo  === STEP 2: deploying to Cloud Run ===
call gcloud run deploy sonicwave --image %IMAGE% --region %REGION% --platform managed --memory 1Gi --cpu 1 --min-instances 0 --max-instances 5 --port 8080 --allow-unauthenticated --vpc-connector sonicstream-vpc --add-cloudsql-instances %SQLCONN% --set-env-vars "%ENVS%" --set-secrets "%SECRETS%"
if errorlevel 1 ( echo DEPLOY FAILED - copy the red text above to Claude. & pause & exit /b 1 )

echo.
echo  === YOUR SERVICE: ===
call gcloud run services list --region %REGION% --filter="metadata.name=sonicwave" --format="table(metadata.name,status.url)"
echo.
echo  Test it: open the URL above + /health/live
pause
