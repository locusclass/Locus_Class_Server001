# Use ultra-lightweight Node Alpine image
FROM node:18-alpine

# Set the working directory
WORKDIR /usr/src/app

# Copy package files first to leverage Docker layer caching
COPY package*.json ./

# Install only production dependencies
RUN npm install --production

# Copy the server code
COPY server.js .

# Ensure the app runs as a non-root user for security
USER node

# Expose the port (Render will override this, but it's good practice)
EXPOSE 8080

# Command to run the signaling server
CMD ["npm", "start"]
