import axios from "axios";
import authService from "./authService";
import { Toast } from "../components/Toast";

class FileService {
  constructor() {
    this.baseUrl = process.env.NEXT_PUBLIC_API_GATEWAY_URL;
    this.uploadLimit = 50 * 1024 * 1024; // 50MB
    this.activeUploads = new Map();
  }

  async validateFile(file) {
    if (!file) {
      Toast.error("파일이 선택되지 않았습니다.");
      return { success: false, message: "파일이 선택되지 않았습니다." };
    }
    if (file.size > this.uploadLimit) {
      Toast.error(
        `파일 크기는 ${this.formatFileSize(
          this.uploadLimit
        )}를 초과할 수 없습니다.`
      );
      return { success: false, message: "파일 크기 초과" };
    }
    return { success: true };
  }

  async initializeUpload(file) {
    const user = authService.getCurrentUser();
    if (!user?.token) throw new Error("인증 정보가 없습니다.");

    const preURL = `${this.baseUrl}/upload/init`;
    const response = await axios.post(
      preURL,
      {
        originalname: file.name,
        mimetype: file.type,
        size: file.size,
      },
      {
        headers: {
          "x-auth-token": user.token,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.data;
  }

  async uploadToS3(uploadUrl, file, onProgress) {
    await axios.put(uploadUrl, file, {
      headers: { "Content-Type": file.type },
      onUploadProgress: (progressEvent) => {
        if (onProgress) {
          const percentCompleted = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          onProgress(percentCompleted);
        }
      },
    });
  }

  async completeUpload(uploadId) {
    const user = authService.getCurrentUser();
    if (!user?.token) throw new Error("인증 정보가 없습니다.");

    const completeURL = `${this.baseUrl}/upload/complete/${uploadId}`;
    const response = await axios.post(
      completeURL,
      {},
      {
        headers: { "x-auth-token": user.token },
      }
    );

    return response.data.data.file;
  }

  async uploadFile(file, onProgress) {
    const validation = await this.validateFile(file);
    if (!validation.success) return validation;

    const uploadData = await this.initializeUpload(file);
    await this.uploadToS3(uploadData.uploadUrl, file, onProgress);
    const uploadedFileData = await this.completeUpload(uploadData.uploadId);

    return { success: true, data: uploadedFileData };
  }

  async getFileInfo(fileId) {
    const user = authService.getCurrentUser();
    if (!user?.token) throw new Error("인증 정보가 없습니다.");

    const fileInfoURL = `${this.baseUrl}/files/${fileId}`;
    const response = await axios.get(fileInfoURL, {
      headers: { "x-auth-token": user.token },
    });

    return response.data.data.file;
  }

  async deleteFile(fileId) {
    const user = authService.getCurrentUser();
    if (!user?.token) throw new Error("인증 정보가 없습니다.");

    const deleteURL = `${this.baseUrl}/files/${fileId}`;
    const response = await axios.delete(deleteURL, {
      headers: { "x-auth-token": user.token },
    });

    return response.data;
  }

  getFileUrl(filename, forPreview = false, withAuth = false) {
    if (!filename) throw new Error("파일 이름이 제공되지 않았습니다.");

    const endpoint = forPreview ? "view" : "download";
    let url = `${this.baseUrl}/api/files/${endpoint}/${filename}`;

    if (withAuth) {
      const user = authService.getCurrentUser();
      if (user?.token) {
        const params = new URLSearchParams();
        params.append("token", user.token);
        if (user.sessionId) params.append("sessionId", user.sessionId);
        url += `?${params.toString()}`;
      }
    }

    return url;
  }

  getPreviewUrl(file, withAuth = true) {
    if (!file?.filename) throw new Error("파일 정보가 제공되지 않았습니다.");

    const baseUrl =
      this.baseUrl || process.env.NEXT_PUBLIC_API_GATEWAY_URL || "";
    const previewUrl = `${baseUrl}/api/files/view/${file.filename}`;

    if (withAuth) {
      const user = authService.getCurrentUser();
      if (!user?.token || !user?.sessionId) {
        throw new Error("인증 정보가 없습니다.");
      }

      const url = new URL(previewUrl);
      url.searchParams.append("token", encodeURIComponent(user.token));
      url.searchParams.append("sessionId", encodeURIComponent(user.sessionId));

      return url.toString();
    }

    return previewUrl;
  }

  formatFileSize(bytes) {
    if (!bytes) return "0 B";
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }
}

export default new FileService();
