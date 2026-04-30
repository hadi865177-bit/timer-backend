module.exports = {
  apps: [{
    name: 'hrms-backend',
    script: 'dist/main.js',
    instances: 1, // Single instance for now, increase if needed
    exec_mode: 'fork',
    max_memory_restart: '1G', // Auto-restart if memory exceeds 1GB
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000,
    kill_timeout: 5000,
    listen_timeout: 10000,
  }]
};
