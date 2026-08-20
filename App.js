import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Alert } from 'react-native';
import MapView, { Polyline, Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';

const LOCATION_TASK_NAME = 'BACKGROUND_LOCATION_RECORD';
let globalRecordedPoints = [];

// Hàm tính khoảng cách giữa 2 tọa độ (theo mét)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) *
    Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// Tác vụ ghi GPS nền chống trôi
TaskManager.defineTask(LOCATION_TASK_NAME, ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data;

  locations.forEach(loc => {
    const { latitude, longitude, accuracy, altitude } = loc.coords;

    // Bỏ qua điểm có sai số lớn hơn 15m
    if (accuracy && accuracy > 15) return;

    // Chỉ ghi khi di chuyển tối thiểu 4m
    if (globalRecordedPoints.length > 0) {
      const lastPoint = globalRecordedPoints[globalRecordedPoints.length - 1];
      const dist = calculateDistance(lastPoint.latitude, lastPoint.longitude, latitude, longitude);
      if (dist < 4) return;
    }

    globalRecordedPoints.push({
      latitude,
      longitude,
      altitude: altitude || 0,
      timestamp: new Date(loc.timestamp).toISOString()
    });
  });
});

export default function App() {
  const [currentLoc, setCurrentLoc] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedRoute, setRecordedRoute] = useState([]);
  const [loadedRoute, setLoadedRoute] = useState([]);
  const [followUser, setFollowUser] = useState(true);
  const [mapType, setMapType] = useState('standard');
  const mapRef = useRef(null);

  useEffect(() => {
    (async () => {
      const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
      if (fgStatus !== 'granted') {
        Alert.alert('Thông báo', 'Cần cấp quyền vị trí để hiển thị bản đồ.');
        return;
      }
      await Location.requestBackgroundPermissionsAsync();

      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation });
      setCurrentLoc(loc.coords);

      Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          distanceInterval: 2,
          timeInterval: 1000
        },
        (newLoc) => {
          if (newLoc.coords.accuracy > 20) return;
          setCurrentLoc(newLoc.coords);

          // Cố định camera bám sát lộ trình không bao giờ bị thu nhỏ
          if (followUser && mapRef.current) {
            mapRef.current.animateCamera(
              {
                center: { latitude: newLoc.coords.latitude, longitude: newLoc.coords.longitude },
                heading: newLoc.coords.heading || 0,
                pitch: 40,
                altitude: 350, // Cố định độ cao 350m chuẩn Apple Maps (cận cảnh đường phố)
                zoom: 18,
              },
              { duration: 800 }
            );
          }
        }
      );
    })();
  }, [followUser]);

  // Cập nhật đường vẽ đỏ
  useEffect(() => {
    let interval = null;
    if (isRecording) {
      interval = setInterval(() => {
        setRecordedRoute([...globalRecordedPoints]);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const toggleMapType = () => {
    if (mapType === 'standard') setMapType('hybrid');
    else if (mapType === 'hybrid') setMapType('satellite');
    else setMapType('standard');
  };

  const getMapTypeName = () => {
    switch (mapType) {
      case 'hybrid': return 'Vệ tinh (Lai)';
      case 'satellite': return 'Vệ tinh';
      default: return 'Tiêu chuẩn';
    }
  };

  const startRecording = async () => {
    globalRecordedPoints = [];
    setRecordedRoute([]);
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      accuracy: Location.Accuracy.BestForNavigation,
      activityType: Location.ActivityType.AutomotiveNavigation,
      distanceInterval: 4,
      showsBackgroundLocationIndicator: true,
      pausesLocationUpdatesAutomatically: false
    });
    setIsRecording(true);
  };

  const stopRecordingAndExport = async () => {
    const hasStarted = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (hasStarted) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    }
    setIsRecording(false);

    if (globalRecordedPoints.length === 0) {
      Alert.alert('Thông báo', 'Chưa có tọa độ nào được ghi nhận.');
      return;
    }

    const gpxString = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="March App" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>March_${Date.now()}</name>
    <trkseg>
${globalRecordedPoints.map(p => `      <trkpt lat="${p.latitude}" lon="${p.longitude}"><ele>${p.altitude}</ele><time>${p.timestamp}</time></trkpt>`).join('\n')}
    </trkseg>
  </trk>
</gpx>`;

    const fileUri = `${FileSystem.documentDirectory}march_${Date.now()}.gpx`;
    await FileSystem.writeAsStringAsync(fileUri, gpxString, { encoding: FileSystem.EncodingType.UTF8 });
    await Sharing.shareAsync(fileUri);
  };

  const importGPX = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: '*/*' });
      if (res.canceled || !res.assets || res.assets.length === 0) return;

      const fileContent = await FileSystem.readAsStringAsync(res.assets[0].uri);
      const regex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/g;
      let match;
      const points = [];
      while ((match = regex.exec(fileContent)) !== null) {
        points.push({
          latitude: parseFloat(match[1]),
          longitude: parseFloat(match[2])
        });
      }

      if (points.length === 0) {
        Alert.alert('Lỗi', 'Không tìm thấy tọa độ trong file GPX.');
        return;
      }

      setLoadedRoute(points);
      setFollowUser(false);

      if (mapRef.current) {
        mapRef.current.fitToCoordinates(points, {
          edgePadding: { top: 80, right: 50, bottom: 150, left: 50 },
          animated: true,
        });
      }
    } catch (e) {
      Alert.alert('Lỗi', 'Không thể mở file GPX.');
    }
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_DEFAULT}
        mapType={mapType}
        showsUserLocation
        showsCompass
        showsMyLocationButton={false}
        onTouchStart={() => setFollowUser(false)}
        initialRegion={{
          latitude: currentLoc ? currentLoc.latitude : 21.0285,
          longitude: currentLoc ? currentLoc.longitude : 105.8542,
          latitudeDelta: 0.003,
          longitudeDelta: 0.003,
        }}
      >
        {/* Đường lộ trình mẫu nạp GPX */}
        {loadedRoute.length > 0 && (
          <>
            <Polyline coordinates={loadedRoute} strokeColor="#00E5FF" strokeWidth={6} />
            <Marker coordinate={loadedRoute[0]} title="Xuất phát" pinColor="green" />
            <Marker coordinate={loadedRoute[loadedRoute.length - 1]} title="Đích đến" pinColor="red" />
          </>
        )}

        {/* Tuyến đường đang ghi */}
        {recordedRoute.length > 0 && (
          <Polyline coordinates={recordedRoute} strokeColor="#FF3B30" strokeWidth={5} />
        )}
      </MapView>

      {/* Header lộ trình GPX đã nạp */}
      {loadedRoute.length > 0 && (
        <View style={styles.routeHeader}>
          <Text style={styles.routeText}>📍 Lộ trình mẫu: {loadedRoute.length} điểm</Text>
          <TouchableOpacity onPress={() => setLoadedRoute([])}>
            <Text style={styles.btnDeleteText}>✕ Xóa</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Nút đổi loại bản đồ */}
      <TouchableOpacity style={styles.btnMapType} onPress={toggleMapType}>
        <Text style={{ fontSize: 18 }}>🗺️</Text>
        <Text style={styles.btnMapTypeText}>{getMapTypeName()}</Text>
      </TouchableOpacity>

      {/* Nút khóa camera bám theo vị trí xe */}
      <TouchableOpacity 
        style={[styles.btnLocate, followUser && styles.btnLocateActive]} 
        onPress={() => setFollowUser(true)}
      >
        <Text style={{ fontSize: 18 }}>🎯</Text>
      </TouchableOpacity>

      {/* Bảng điều khiển dưới cùng */}
      <View style={styles.panel}>
        {!isRecording ? (
          <TouchableOpacity style={[styles.btn, styles.btnStart]} onPress={startRecording}>
            <Text style={styles.btnText}>Ghi lộ trình</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.btn, styles.btnStop]} onPress={stopRecordingAndExport}>
            <Text style={styles.btnText}>Dừng & Xuất GPX</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={[styles.btn, styles.btnImport]} onPress={importGPX}>
          <Text style={styles.btnText}>Nạp file GPX</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { width: '100%', height: '100%' },
  routeHeader: {
    position: 'absolute',
    top: 55,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.8)',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  routeText: { color: '#FFF', fontWeight: '600', fontSize: 13 },
  btnDeleteText: { color: '#FF3B30', fontWeight: 'bold', fontSize: 13 },
  btnMapType: {
    position: 'absolute',
    right: 20,
    bottom: 175,
    backgroundColor: '#FFF',
    paddingHorizontal: 10,
    height: 44,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 5,
    elevation: 4,
  },
  btnMapTypeText: { fontSize: 12, fontWeight: 'bold', color: '#333' },
  btnLocate: {
    position: 'absolute',
    right: 20,
    bottom: 120,
    backgroundColor: '#FFF',
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 5,
    elevation: 4,
  },
  btnLocateActive: { borderWidth: 2, borderColor: '#007AFF' },
  panel: {
    position: 'absolute',
    bottom: 35,
    left: 15,
    right: 15,
    flexDirection: 'row',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    padding: 10,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 10,
  },
  btn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center', marginHorizontal: 5 },
  btnStart: { backgroundColor: '#34C759' },
  btnStop: { backgroundColor: '#FF3B30' },
  btnImport: { backgroundColor: '#007AFF' },
  btnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
});
